import { spawn, type ChildProcess } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import type { DoneEvent, EncoderKind, FailEvent, ProbeInfo, ProgressEvent } from "../../shared/types";
import { exceedsTarget, retryVideoBitrateBps, targetBytesFromMB } from "../../shared/bitrate";
import { selectEncoder } from "../../shared/encoder";
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
  targetMB: number;
  caps: EncoderCaps;
  preferredEncoder?: EncoderKind;
  hooks: JobHooks;
}

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
    const targetBytes = targetBytesFromMB(req.targetMB);
    const outSize = fitOutput(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
    const outputPath = allocateOutputPath(req.probe.path, req.hooks.exists, outSize);
    const tempOut = partialPath(outputPath);
    const passLog = passLogPrefix(outputPath);
    this.temps.push(tempOut, passLog);

    const caps = req.preferredEncoder === "x265" && req.caps.x265
      ? { ...req.caps, videotoolbox: false }
      : req.caps;
    let encoder = selectEncoder(caps);
    if (!encoder) {
      this.running = false;
      req.hooks.onFail({ message: "本机没有可用的 HEVC 编码器。" });
      return;
    }

    let used = encoder;
    let lastFailed: EncoderKind | undefined;

    try {
      for (;;) {
        if (this.cancelled) throw new CancelError();
        encoder = selectEncoder(caps, { lastFailed });
        if (!encoder) {
          throw new Error("encoder unavailable");
        }
        used = encoder;
        const plan = buildCommands({
          encoder,
          ffmpegPath: req.ffmpegPath,
          input: req.probe.path,
          output: tempOut,
          probe: req.probe,
          targetBytes,
          passLog,
        });
        let retried = false;
        try {
          await this.runPlan(req, plan, false);
          const firstStat = await stat(tempOut);
          if (exceedsTarget(firstStat.size, targetBytes)) {
            retried = true;
            const videoBps = retryVideoBitrateBps(plan.videoBitrateBps, firstStat.size, targetBytes);
            await removeTempFiles(this.temps);
            const retryPlan = buildCommands({
              encoder, ffmpegPath: req.ffmpegPath, input: req.probe.path,
              output: tempOut, probe: req.probe, targetBytes, videoBps, passLog,
            });
            await this.runPlan(req, retryPlan, true);
          }
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
        const exceededTarget = exceedsTarget(finalStat.size, targetBytes);
        if (this.cancelled) throw new CancelError();
        if (exceededTarget || finalStat.size >= req.probe.sizeBytes) {
          await removeTempFiles(this.temps);
          this.running = false;
          req.hooks.onFail({ message: "未能压到目标体积，未保存压缩结果。请适当调大目标后重试；原片没有改动。" });
          return;
        }

        await rename(tempOut, outputPath);
        await removeTempFiles([passLog]);
        this.running = false;
        req.hooks.onDone({
          outputPath,
          inputBytes: req.probe.sizeBytes,
          outputBytes: finalStat.size,
          savedBytes: Math.max(0, req.probe.sizeBytes - finalStat.size),
          encoder: used,
          retried,
          exceededTarget,
          elapsedSec: this.elapsedSec(),
        });
        return;
      }
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

  private runPlan(req: JobRequest, plan: ReturnType<typeof buildCommands>, isRetry: boolean): Promise<void> {
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
        const phase = twoPass ? (index === 0 ? "pass1" : "pass2") : isRetry ? "retry" : "single";
        const dim = outputLabel(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
        const message =
          phase === "pass1"
            ? "第一遍：分析画面，为第二遍编码做准备"
            : phase === "pass2"
              ? `第二遍：按目标上限编码为 ${dim} HEVC`
              : isRetry
                ? `输出略超目标，正在按上限再压为 ${dim} HEVC`
                : `正在按目标体积编码为 ${dim} HEVC`;
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
