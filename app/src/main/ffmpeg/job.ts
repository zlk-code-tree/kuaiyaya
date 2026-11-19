import { spawn, type ChildProcess } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import type { DoneEvent, EncoderKind, FailEvent, ProbeInfo, ProgressEvent } from "../../shared/types";
import { retryVideoBitrateBps, targetBytesFromMB, videoBitrateBps } from "../../shared/bitrate";
import { selectEncoder } from "../../shared/encoder";
import { MSG } from "../../shared/messages";
import { allocateOutputPath, partialPath, passLogPrefix } from "../../shared/output-name";
import { displaySize, fitOutput, outputLabel } from "../../shared/scale";
import { buildCommands } from "./bitrate-cmd";
import { removeTempFiles } from "./cleanup";
import { etaSeconds, parseProgressLine, ratioFromOutTime } from "./progress";
import type { EncoderCaps } from "../../shared/types";

export interface JobHooks {
  onProgress: (e: ProgressEvent) => void;
  onDone: (e: DoneEvent) => void;
  onFail: (e: FailEvent) => void;
  exists: (p: string) => boolean;
}

export interface JobRequest {
  ffmpegPath: string;
  probe: ProbeInfo;
  /** null 表示没填，只走清晰度优先。正整数是必须压进的上限。 */
  targetMB: number | null;
  caps: EncoderCaps;
  preferredEncoder?: EncoderKind;
  hooks: JobHooks;
}

type EncodeKind = "quality" | "bitrate" | "retry";

export class CompressJob {
  private child: ChildProcess | null = null;
  private cancelled = false;
  private temps: string[] = [];
  private running = false;
  private startedAt = 0;

  private elapsedSec(): number {
    return Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
  }

  get isRunning(): boolean {
    return this.running;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const child = this.child;
    if (child?.pid) {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 1500).unref();
      } catch {
        /* ignore */
      }
    }
  }

  async run(req: JobRequest): Promise<void> {
    if (this.running) {
      throw new Error("already running");
    }
    this.running = true;
    this.cancelled = false;
    this.temps = [];
    this.startedAt = Date.now();
    const limitBytes = req.targetMB == null ? null : targetBytesFromMB(req.targetMB);
    const outSize = fitOutput(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
    const outputPath = allocateOutputPath(req.probe.path, req.hooks.exists, outSize);
    const tempOut = partialPath(outputPath);
    const passLog = passLogPrefix(outputPath);
    this.temps.push(tempOut, passLog);

    const initial = selectEncoder(this.capsFor(req));
    if (!initial) {
      this.running = false;
      req.hooks.onFail({ message: "本机没有可用的 HEVC 编码器。" });
      return;
    }

    try {
      const quality = await this.encodeStage(req, "quality", undefined, tempOut, passLog);
      if (quality.size >= req.probe.sizeBytes) {
        await this.failKept(req, MSG.sizeNotSmaller);
        return;
      }
      if (limitBytes == null || quality.size <= limitBytes) {
        await this.save(req, outputPath, tempOut, passLog, quality.encoder, quality.size, false, false);
        return;
      }

      await removeTempFiles(this.temps);
      const bps = videoBitrateBps({
        targetBytes: limitBytes,
        durationSec: req.probe.durationSec,
        hasAudio: req.probe.hasAudio,
      });
      const constrained = await this.encodeStage(req, "bitrate", bps, tempOut, passLog);
      if (constrained.size >= req.probe.sizeBytes) {
        await this.failKept(req, MSG.sizeNotSmaller);
        return;
      }
      if (constrained.size <= limitBytes) {
        await this.save(req, outputPath, tempOut, passLog, constrained.encoder, constrained.size, true, false);
        return;
      }

      await removeTempFiles(this.temps);
      const retryBps = retryVideoBitrateBps(bps, constrained.size, limitBytes);
      const retried = await this.encodeStage(req, "retry", retryBps, tempOut, passLog);
      if (retried.size >= req.probe.sizeBytes) {
        await this.failKept(req, MSG.sizeNotSmaller);
        return;
      }
      if (retried.size <= limitBytes) {
        await this.save(req, outputPath, tempOut, passLog, retried.encoder, retried.size, true, true);
        return;
      }
      await this.failKept(req, MSG.overLimit);
    } catch (err) {
      await removeTempFiles(this.temps);
      this.running = false;
      if (this.cancelled || err instanceof CancelError) {
        req.hooks.onFail({ message: "已取消。未完成的临时文件已清理，原片没有改动。", cancelled: true });
        return;
      }
      req.hooks.onFail({
        message: err instanceof Error && err.message === "encoder unavailable"
          ? "编码器不可用，压缩未能完成。原片没有被修改，临时文件已清理。"
          : "编码未能完成。原片没有被修改，临时文件已清理。",
      });
    }
  }

  private capsFor(req: JobRequest): EncoderCaps {
    return req.preferredEncoder === "x265" && req.caps.x265
      ? { ...req.caps, videotoolbox: false }
      : req.caps;
  }

  private async encodeStage(
    req: JobRequest,
    kind: EncodeKind,
    videoBps: number | undefined,
    tempOut: string,
    passLog: string,
  ): Promise<{ encoder: EncoderKind; size: number }> {
    const caps = this.capsFor(req);
    let lastFailed: EncoderKind | undefined;
    for (;;) {
      if (this.cancelled) throw new CancelError();
      const encoder = selectEncoder(caps, { lastFailed });
      if (!encoder) throw new Error("encoder unavailable");
      const plan = buildCommands({
        encoder,
        ffmpegPath: req.ffmpegPath,
        input: req.probe.path,
        output: tempOut,
        probe: req.probe,
        targetBytes: kind === "quality" ? undefined : targetBytesFromMB(req.targetMB ?? 1),
        videoBps,
        passLog,
        mode: kind === "quality" ? "quality" : "bitrate",
      });
      try {
        await this.runPlan(req, plan, kind);
      } catch (err) {
        if (this.cancelled) throw new CancelError();
        if (encoder === "videotoolbox" && req.caps.x265 && isEncoderFailure(err)) {
          lastFailed = "videotoolbox";
          await removeTempFiles(this.temps);
          continue;
        }
        throw err;
      }
      const finalStat = await stat(tempOut);
      if (this.cancelled) throw new CancelError();
      return { encoder, size: finalStat.size };
    }
  }

  private async save(
    req: JobRequest,
    outputPath: string,
    tempOut: string,
    passLog: string,
    encoder: EncoderKind,
    size: number,
    qualityReduced: boolean,
    retried: boolean,
  ): Promise<void> {
    await rename(tempOut, outputPath);
    await removeTempFiles([passLog]);
    this.running = false;
    req.hooks.onDone({
      outputPath,
      inputBytes: req.probe.sizeBytes,
      outputBytes: size,
      savedBytes: Math.max(0, req.probe.sizeBytes - size),
      encoder,
      retried,
      qualityReduced,
      elapsedSec: this.elapsedSec(),
    });
  }

  private async failKept(req: JobRequest, message: string): Promise<void> {
    await removeTempFiles(this.temps);
    this.running = false;
    req.hooks.onFail({ message });
  }

  private runPlan(req: JobRequest, plan: ReturnType<typeof buildCommands>, kind: EncodeKind): Promise<void> {
    return new Promise((resolve, reject) => {
      const runPass = (index: number) => {
        if (this.cancelled) {
          reject(new CancelError());
          return;
        }
        const args = plan.args[index];
        if (!args) {
          resolve();
          return;
        }
        const twoPass = plan.args.length > 1;
        const phase = twoPass ? (index === 0 ? "pass1" : "pass2") : kind === "retry" ? "retry" : "single";
        const dim = outputLabel(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
        const message =
          phase === "pass1"
            ? "第一遍：分析画面，为第二遍编码做准备"
            : phase === "pass2"
              ? `第二遍：按目标上限编码为 ${dim} HEVC`
              : kind === "quality"
                ? `正在按清晰度优先编码为 ${dim} HEVC`
                : `正在按目标上限编码为 ${dim} HEVC`;
        const started = Date.now();
        req.hooks.onProgress({
          encoder: plan.encoder,
          phase,
          ratio: 0,
          percent: 0,
          etaSec: null,
          elapsedSec: this.elapsedSec(),
          message,
        });
        const child = spawn(req.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        this.child = child;
        let stderr = "";
        child.stderr?.on("data", (buf: Buffer) => {
          stderr += buf.toString("utf8");
          if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
        });
        let acc = "";
        child.stdout?.on("data", (buf: Buffer) => {
          acc += buf.toString("utf8");
          const lines = acc.split(/\r?\n/);
          acc = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseProgressLine(line);
            if (parsed.outTimeUs != null) {
              const ratio = ratioFromOutTime(parsed.outTimeUs, req.probe.durationSec);
              req.hooks.onProgress({
                encoder: plan.encoder,
                phase,
                ratio,
                percent: Math.round(ratio * 100),
                etaSec: etaSeconds(ratio, Date.now() - started),
                elapsedSec: this.elapsedSec(),
                message,
              });
            }
          }
        });
        child.on("error", (err) => {
          this.child = null;
          reject(err);
        });
        child.on("close", (code) => {
          this.child = null;
          if (this.cancelled) {
            reject(new CancelError());
            return;
          }
          if (code !== 0) {
            reject(new FfmpegError(code ?? 1, stderr));
            return;
          }
          runPass(index + 1);
        });
      };
      runPass(0);
    });
  }
}

class CancelError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelError";
  }
}

class FfmpegError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`ffmpeg exited ${exitCode}`);
    this.name = "FfmpegError";
  }
}

function isEncoderFailure(err: unknown): boolean {
  if (err instanceof FfmpegError) {
    const s = err.stderr.toLowerCase();
    return (
      s.includes("videotoolbox") ||
      s.includes("cannot load") ||
      s.includes("encoder not found") ||
      s.includes("unknown encoder") ||
      s.includes("error while opening encoder")
    );
  }
  return false;
}
