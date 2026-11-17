import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_NAME, MSG } from "../shared/messages";
import type { EncoderCaps } from "../shared/types";
import { resolveBinaries } from "./ffmpeg/binary";
import { detectCaps } from "./ffmpeg/detect";
import { CompressJob } from "./ffmpeg/job";
import { QualityAnalyzer } from "./ffmpeg/quality-analysis";
import { UpdateChecker } from "./update/checker";
import { KeychainStore, MemorySecretStore, WindowsSecretStore } from "./license/store";
import { LicenseSession } from "./license/session";
import { registerIpc } from "./ipc";
import { loadConfig, type AppConfig } from "./paths";
import { prepareQueueItem } from "./queue/prepare";
import { BatchQueue } from "./queue/runner";

app.setName(APP_NAME);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let config: AppConfig;
const job = new CompressJob();
const analyzer = new QualityAnalyzer();
let queue: BatchQueue | null = null;
let queueClosePrompt: Promise<boolean> | null = null;
let queueCloseConfirmed = false;
const secrets = process.platform === "darwin" ? new KeychainStore() : process.platform === "win32" ? new WindowsSecretStore() : new MemorySecretStore();
let session: LicenseSession;
let capsPromise: Promise<EncoderCaps> | null = null;
let binsPromise: Promise<{ ffmpeg: string; ffprobe: string }> | null = null;

function getBins() {
  if (!binsPromise) {
    binsPromise = resolveBinaries().then((b) => ({ ffmpeg: b.ffmpeg, ffprobe: b.ffprobe }));
  }
  return binsPromise;
}

function getCaps() {
  if (!capsPromise) {
    capsPromise = getBins().then((b) => detectCaps(b.ffmpeg));
  }
  return capsPromise;
}

function askStopQueue(win: BrowserWindow): Promise<boolean> {
  if (!queueClosePrompt) {
    queueClosePrompt = dialog.showMessageBox(win, {
      type: "question",
      buttons: ["再想想", "确定取消"],
      defaultId: 0,
      cancelId: 0,
      title: MSG.queueCloseTitle,
      message: MSG.queueCloseTitle,
      detail: MSG.queueCloseDetail,
    }).then((res) => res.response === 1).finally(() => {
      queueClosePrompt = null;
    });
  }
  return queueClosePrompt;
}

async function stopQueueForClose(win: BrowserWindow): Promise<boolean> {
  if (queueCloseConfirmed) return true;
  const ok = await askStopQueue(win);
  if (!ok) return false;
  queueCloseConfirmed = true;
  await queue?.cancelAllAndWait();
  return true;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 740,
    height: 640,
    minWidth: 740,
    minHeight: 640,
    resizable: false,
    title: APP_NAME,
    backgroundColor: "#f6f6f8",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.on("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (analyzer.isRunning) {
      e.preventDefault();
      void (async () => {
        const res = await dialog.showMessageBox(win, {
          type: "question", buttons: ["继续分析", "取消分析并关闭"], defaultId: 0, cancelId: 0,
          title: "确定取消画质分析？", message: "确定取消画质分析并关闭？", detail: "临时试压文件会被清理，原片不会改动。",
        });
        if (res.response === 1) {
          await analyzer.cancel();
          win.destroy();
        }
      })();
      return;
    }
    if (queue?.isBusy()) {
      e.preventDefault();
      void stopQueueForClose(win).then((ok) => {
        if (ok && !win.isDestroyed()) win.destroy();
      });
      return;
    }
    if (!job.isRunning) return;
    e.preventDefault();
    void (async () => {
      const res = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["再想想", "确定取消"],
        defaultId: 0,
        cancelId: 0,
        title: MSG.closeWhileWorkTitle,
        message: MSG.closeWhileWorkTitle,
        detail: MSG.closeWhileWork,
      });
      if (res.response === 1) {
        await job.cancel();
        win.destroy();
      }
    })();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWindow = win;
}

app.on("second-instance", () => {
  const win = mainWindow;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  config = await loadConfig();
  session = new LicenseSession(secrets, () => ({ baseUrl: config.apiBaseUrl }), app.getVersion());
  const updates = new UpdateChecker(() => config.apiBaseUrl, app.getVersion(), process.platform, process.arch, (url) => shell.openExternal(url));
  session.onChange((s) => mainWindow?.webContents.send("license-change", s));
  queue = new BatchQueue({
    decideStart: () => session.decideStart(),
    prepare: (item) => prepareQueueItem(getBins, item),
    runJob: async (item, info, hooks) => {
      const bins = await getBins();
      const caps = await getCaps();
      await job.run({
        ffmpegPath: bins.ffmpeg,
        probe: info,
        targetMB: item.targetMB,
        caps,
        hooks: {
          exists: (filePath) => existsSync(filePath),
          onProgress: hooks.onProgress,
          onDone: hooks.onDone,
          onFail: hooks.onFail,
        },
      });
    },
    cancelJob: () => job.cancel(),
    onUpdate: (snapshot) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      win.webContents.send("queue-update", snapshot);
    },
  });
  registerIpc({
    getWindow: () => mainWindow,
    session,
    getConfig: () => config,
    job,
    analyzer,
    updates,
    getCaps,
    getFfmpeg: getBins,
    queue,
  });
  createWindow();
  void session.boot();
  void getCaps();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (queue?.isBusy()) {
    event.preventDefault();
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    void stopQueueForClose(win).then((ok) => {
      if (ok) app.quit();
    });
    return;
  }
  if (analyzer.isRunning) void analyzer.cancel();
  if (job.isRunning) {
    void job.cancel();
  }
});

