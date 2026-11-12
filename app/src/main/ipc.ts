import { BrowserWindow, ipcMain, clipboard, app } from "electron";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { EncoderCaps, ProbeInfo, StartInput } from "../shared/types";
import { APP_NAME, FEEDBACK_EMAIL, MAINTAINER, MSG } from "../shared/messages";
import { LicenseSession } from "./license/session";
import { probeFile, isLikelyVideoPath } from "./ffmpeg/probe";
import { CompressJob } from "./ffmpeg/job";
import { checkGuards } from "./fs/guard";
import { selectVideo } from "./fs/dialog";
import { openFile, revealInFinder } from "./fs/open";
import { qrPath, type AppConfig } from "./paths";

export interface MainContext {
  getWindow: () => BrowserWindow | null;
  session: LicenseSession;
  getConfig: () => AppConfig;
  job: CompressJob;
  getCaps: () => Promise<EncoderCaps>;
  getFfmpeg: () => Promise<{ ffmpeg: string; ffprobe: string }>;
}

const probes = new Map<string, ProbeInfo>();

export function registerIpc(ctx: MainContext): void {
  ipcMain.handle("select-video", async () => {
    const win = ctx.getWindow();
    if (!win) return null;
    return selectVideo(win);
  });

  ipcMain.handle("probe", async (_e, filePath: string) => {
    if (typeof filePath !== "string") throw new Error(MSG.unsupported);
    if (!isLikelyVideoPath(filePath) && !existsSync(filePath)) {
      throw new Error(MSG.unsupported);
    }
    const bins = await ctx.getFfmpeg();
    try {
      const info = await probeFile(bins.ffprobe, filePath);
      probes.set(info.path, info);
      return info;
    } catch {
      throw new Error(MSG.unsupported);
    }
  });

  ipcMain.handle("check-start-guards", async (_e, input: StartInput) => {
    const probe = probes.get(input.filePath);
    if (!probe) return { ok: false, reason: "unsupported", message: MSG.unsupported };
    return checkGuards(probe, input.targetMB);
  });

  ipcMain.handle("start-compress", async (_e, input: StartInput) => {
    if (ctx.job.isRunning) return;
    const probe = probes.get(input.filePath);
    if (!probe) throw new Error(MSG.unsupported);
    const decision = await ctx.session.decideStart();
    if (decision.action !== "start") {
      throw Object.assign(new Error(decision.action === "block" ? decision.message : "请稍候…"), {
        license: decision,
      });
    }
    const guard = await checkGuards(probe, input.targetMB);
    if (!guard.ok) {
      throw Object.assign(new Error(guard.message), { guard });
    }
    const bins = await ctx.getFfmpeg();
    const caps = await ctx.getCaps();
    const win = ctx.getWindow();
    void ctx.job.run({
      ffmpegPath: bins.ffmpeg,
      probe,
      targetMB: input.targetMB,
      caps,
      hooks: {
        exists: (p) => existsSync(p),
        onProgress: (ev) => win?.webContents.send("compress-progress", ev),
        onDone: (ev) => win?.webContents.send("compress-done", ev),
        onFail: (ev) => win?.webContents.send("compress-fail", ev),
      },
    });
  });

  ipcMain.handle("cancel-compress", async () => {
    await ctx.job.cancel();
  });

  ipcMain.handle("open-file", async (_e, filePath: string) => {
    try {
      await openFile(filePath);
    } catch {
      throw new Error(MSG.missingOutput);
    }
  });

  ipcMain.handle("reveal-in-finder", async (_e, filePath: string) => {
    try {
      await revealInFinder(filePath);
    } catch {
      throw new Error(MSG.missingOutput);
    }
  });

  ipcMain.handle("license-get-state", async () => ctx.session.getState());
  ipcMain.handle("license-activate", async (_e, key: string) => ctx.session.activate(String(key ?? "")));
  ipcMain.handle("license-reenter", async () => ctx.session.reenterKey());

  ipcMain.handle("about", async () => {
    const qr = qrPath();
    return {
      name: APP_NAME,
      version: app.getVersion(),
      maintainer: MAINTAINER,
      email: FEEDBACK_EMAIL,
      qrSrc: pathToFileURL(qr).toString(),
    };
  });

  ipcMain.handle("copy-text", async (_e, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle("get-encoder-caps", async () => ctx.getCaps());
}

export function isCompressing(job: CompressJob): boolean {
  return job.isRunning;
}
