import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { APP_NAME, MSG } from "../shared/messages";
import type { EncoderCaps } from "../shared/types";
import { resolveBinaries } from "./ffmpeg/binary";
import { detectCaps } from "./ffmpeg/detect";
import { CompressJob } from "./ffmpeg/job";
import { KeychainStore, MemorySecretStore } from "./license/store";
import { LicenseSession } from "./license/session";
import { registerIpc } from "./ipc";
import { loadConfig, type AppConfig } from "./paths";

app.setName(APP_NAME);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let config: AppConfig;
const job = new CompressJob();
const secrets = process.platform === "darwin" ? new KeychainStore() : new MemorySecretStore();
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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 740,
    height: 640,
    minWidth: 740,
    minHeight: 640,
    resizable: false,
    title: APP_NAME,
    backgroundColor: "#f6f6f8",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
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
  session.onChange((s) => mainWindow?.webContents.send("license-change", s));
  registerIpc({
    getWindow: () => mainWindow,
    session,
    getConfig: () => config,
    job,
    getCaps,
    getFfmpeg: getBins,
  });
  createWindow();
  void session.boot();
  void getCaps();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (job.isRunning) {
    void job.cancel();
  }
});

