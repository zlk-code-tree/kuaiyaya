import { BrowserWindow, ipcMain, clipboard, app } from "electron";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { QueueConcurrencyInfo, QueueStartItem, QueueStartRequest } from "../shared/queue";
import type { EncoderCaps, ProbeInfo, QualityAnalysis, StartInput } from "../shared/types";
import type { BatchQueue } from "./queue/runner";
import { isTargetTooLarge } from "../shared/bitrate";
import { APP_NAME, FEEDBACK_EMAIL, MAINTAINER, MSG } from "../shared/messages";
import { LicenseSession } from "./license/session";
import { probeFile, isLikelyVideoPath } from "./ffmpeg/probe";
import { CompressJob } from "./ffmpeg/job";
import { QualityAnalyzer } from "./ffmpeg/quality-analysis";
import { UpdateChecker } from "./update/checker";
import { checkGuards } from "./fs/guard";
import { selectVideo } from "./fs/dialog";
import { openFile, revealInFinder } from "./fs/open";
import type { OutputPreviewGate } from "./media-protocol";
import { qrPath, type AppConfig } from "./paths";

export interface MainContext {
  getWindow: () => BrowserWindow | null;
  session: LicenseSession;
  getConfig: () => AppConfig;
  job: CompressJob;
  analyzer: QualityAnalyzer;
  updates: UpdateChecker;
  getCaps: () => Promise<EncoderCaps>;
  getQueueConcurrency: () => Promise<QueueConcurrencyInfo>;
  getFfmpeg: () => Promise<{ ffmpeg: string; ffprobe: string }>;
  queue: BatchQueue;
  preview: OutputPreviewGate;
}

const probes = new Map<string, ProbeInfo>();
const signatures = new Map<string, { size: number; mtimeMs: number; ino: number }>();
const analyses = new Map<string, QualityAnalysis>();
let pendingAnalysis: { cancelled: boolean } | null = null;

async function currentProbe(filePath: string): Promise<ProbeInfo> {
  const probe = probes.get(filePath);
  const previous = signatures.get(filePath);
  if (!probe || !previous) throw new Error(MSG.unsupported);
  const file = await stat(filePath).catch(() => null);
  if (!file || file.size !== previous.size || file.mtimeMs !== previous.mtimeMs || file.ino !== previous.ino) {
    analyses.delete(filePath);
    throw new Error("视频文件已发生变化，请重新选择。");
  }
  return probe;
}

/** null / 缺省 = 没填。0、负数和非数字是无效上限。 */
function readCap(value: unknown): number | null | "bad" {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "bad";
  const mb = Math.round(numeric);
  if (mb < 1) return "bad";
  return mb;
}

function readQueueItems(input: QueueStartRequest | undefined): QueueStartItem[] {
  if (!input || !Array.isArray(input.items)) return [];
  const items: QueueStartItem[] = [];
  for (const raw of input.items) {
    if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.filePath !== "string" || !raw.filePath) continue;
    const targetMB = readCap(raw.targetMB);
    if (targetMB === "bad") continue;
    items.push({
      id: raw.id,
      filePath: raw.filePath,
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.filePath,
      targetMB,
      sizeBytes: Number.isFinite(Number(raw.sizeBytes)) ? Number(raw.sizeBytes) : 0,
      durationSec: Number.isFinite(Number(raw.durationSec)) ? Number(raw.durationSec) : 0,
      displayWidth: Number.isFinite(Number(raw.displayWidth)) ? Number(raw.displayWidth) : 0,
      displayHeight: Number.isFinite(Number(raw.displayHeight)) ? Number(raw.displayHeight) : 0,
    });
  }
  return items;
}

function busy(): { ok: false; code: "busy"; message: string } {
  return { ok: false, code: "busy", message: "正在处理其他任务，请稍候。" };
}

export function registerIpc(ctx: MainContext): void {
  ipcMain.handle("select-video", async () => {
    const win = ctx.getWindow();
    if (!win) return [];
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
      const file = await stat(info.path);
      if (file.size !== info.sizeBytes) throw new Error("文件已发生变化");
      probes.set(info.path, info);
      signatures.set(info.path, { size: file.size, mtimeMs: file.mtimeMs, ino: file.ino });
      analyses.delete(info.path);
      return info;
    } catch {
      throw new Error(MSG.unsupported);
    }
  });

  ipcMain.handle("check-start-guards", async (_e, input: StartInput) => {
    const probe = probes.get(input.filePath);
    if (!probe) return { ok: false, reason: "unsupported", message: MSG.unsupported };
    const cap = readCap(input?.targetMB);
    if (cap === "bad") return { ok: false, reason: "target_too_large", message: "请输入小于原片大小的有效目标。" };
    if (cap != null && isTargetTooLarge(cap, probe.sizeBytes)) {
      return { ok: false, reason: "target_too_large", message: MSG.targetTooLarge };
    }
    return checkGuards(probe, cap);
  });

  ipcMain.handle("start-compress", async (_e, input: StartInput) => {
    if (ctx.queue.isBusy()) throw new Error("正在处理其他任务，请稍候。");
    const probe = await currentProbe(input.filePath);
    const cap = readCap(input?.targetMB);
    if (cap === "bad") throw new Error("请输入小于原片大小的有效目标。");
    if (cap != null && isTargetTooLarge(cap, probe.sizeBytes)) throw new Error(MSG.targetTooLarge);
    const decision = await ctx.session.decideStart();
    if (decision.action !== "start") {
      throw Object.assign(new Error(decision.action === "block" ? decision.message : "请稍候…"), {
        license: decision,
      });
    }
    const guard = await checkGuards(probe, cap);
    if (!guard.ok) {
      throw Object.assign(new Error(guard.message), { guard });
    }
    const bins = await ctx.getFfmpeg();
    const caps = await ctx.getCaps();
    if (ctx.queue.isBusy() || ctx.job.isRunning || ctx.analyzer.isRunning || pendingAnalysis) throw new Error("正在处理其他任务，请稍候。");
    const previous = analyses.get(input.filePath);
    const preferredEncoder = previous?.encoder;
    const win = ctx.getWindow();
    ctx.preview.revoke();
    void ctx.job.run({
      ffmpegPath: bins.ffmpeg,
      probe,
      targetMB: cap,
      caps,
      preferredEncoder,
      hooks: {
        exists: (p) => existsSync(p),
        onProgress: (ev) => win?.webContents.send("compress-progress", ev),
        onDone: (ev) => {
          ctx.preview.noteSuccess(ev.outputPath);
          win?.webContents.send("compress-done", ev);
        },
        onFail: (ev) => win?.webContents.send("compress-fail", ev),
      },
    });
  });

  ipcMain.handle("cancel-compress", async () => {
    await ctx.job.cancel();
  });

  ipcMain.handle("queue-start", async (_e, input: QueueStartRequest) => {
    if (ctx.queue.isBusy() || ctx.job.isRunning || ctx.analyzer.isRunning || pendingAnalysis) return busy();
    const items = readQueueItems(input);
    if (items.length === 0) return { ok: false, message: "没有可以压缩的视频。" };
    ctx.preview.revoke();
    return ctx.queue.start(items);
  });

  ipcMain.handle("queue-cancel-item", async (_e, id: string) => {
    if (typeof id === "string") ctx.queue.cancelItem(id);
  });

  ipcMain.handle("queue-cancel-all", async () => {
    ctx.queue.cancelAll();
  });

  ipcMain.handle("queue-retry", async (_e, input: { id?: string; allFailed?: boolean }) => {
    ctx.preview.revoke();
    if (input?.allFailed) ctx.queue.retryFailed();
    else if (typeof input?.id === "string") ctx.queue.retryItem(input.id);
  });

  ipcMain.handle("analyze-quality", async (_e, input: StartInput) => {
    if (ctx.queue.isBusy() || ctx.job.isRunning || pendingAnalysis) throw new Error("正在处理其他任务，请稍候。");
    const pending = { cancelled: false };
    pendingAnalysis = pending;
    const win = ctx.getWindow();
    try {
      const probe = await currentProbe(input.filePath);
      const decision = await ctx.session.decideStart();
      if (decision.action !== "start") {
        throw new Error(decision.action === "block" ? decision.message : "正在校验 Key，请稍候。");
      }
      const bins = await ctx.getFfmpeg();
      const caps = await ctx.getCaps();
      if (pending.cancelled || !win || win.isDestroyed()) throw new Error("已取消画质分析。");
      if (ctx.queue.isBusy() || ctx.job.isRunning || ctx.analyzer.isRunning) throw new Error("正在处理其他任务，请稍候。");
      const result = await ctx.analyzer.run({
        ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, probe, caps,
        onProgress: (event) => { if (!win.isDestroyed()) win.webContents.send("analysis-progress", event); },
      });
      if (pending.cancelled) throw new Error("已取消画质分析。");
      await currentProbe(input.filePath);
      if (pending.cancelled) throw new Error("已取消画质分析。");
      analyses.set(input.filePath, result);
      return result;
    } finally {
      if (pendingAnalysis === pending) pendingAnalysis = null;
    }
  });

  ipcMain.handle("cancel-analysis", async () => {
    if (pendingAnalysis) pendingAnalysis.cancelled = true;
    await ctx.analyzer.cancel();
  });

  ipcMain.handle("acquire-output-preview", async (_e, filePath: unknown) => {
    if (typeof filePath !== "string") return null;
    return ctx.preview.acquire(filePath);
  });

  ipcMain.handle("release-output-preview", async () => {
    ctx.preview.revoke();
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

  ipcMain.handle("check-for-updates", async () => ctx.updates.check());
  ipcMain.handle("open-update-download", async () => ctx.updates.openDownload());

  ipcMain.handle("about", async () => {
    let qrSrc = "";
    try {
      const qr = qrPath();
      if (existsSync(qr)) {
        qrSrc = `data:image/png;base64,${(await readFile(qr)).toString("base64")}`;
      }
    } catch {
      qrSrc = "";
    }
    return {
      name: APP_NAME,
      version: app.getVersion(),
      maintainer: MAINTAINER,
      email: FEEDBACK_EMAIL,
      qrSrc,
    };
  });

  ipcMain.handle("copy-text", async (_e, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle("get-encoder-caps", async () => ctx.getCaps());

  ipcMain.handle("get-queue-concurrency", async () => ctx.getQueueConcurrency());
}

export function isCompressing(job: CompressJob): boolean {
  return job.isRunning;
}
