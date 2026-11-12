import { spawn, type ChildProcess } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import type { DoneEvent, EncoderKind, FailEvent, ProbeInfo, ProgressEvent } from "../../shared/types";
import { exceedsTarget, retryVideoBitrateBps, targetBytesFromMB } from "../../shared/bitrate";
import { selectEncoder } from "../../shared/encoder";
import { allocateOutputPath, partialPath, passLogPrefix } from "../../shared/output-name";
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
  hooks: JobHooks;
}

export class CompressJob {
  private child: ChildProcess | null = null;
  private cancelled = false;
  private temps: string[] = [];
  private running = false;

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
    const targetBytes = targetBytesFromMB(req.targetMB);
    const outputPath = allocateOutputPath(req.probe.path, req.hooks.exists);
    const tempOut = partialPath(outputPath);
    const passLog = passLogPrefix(outputPath);
    this.temps.push(tempOut, passLog);

    let encoder = selectEncoder(req.caps);
    if (!encoder) {
      this.running = false;
      req.hooks.onFail({ message: "本机没有可用的 HEVC 编码器。" });
      return;
    }

    let retried = false;
    let used = encoder;
    let lastFailed: EncoderKind | undefined;

    try {
      for (;;) {
        if (this.cancelled) throw new CancelError();
        encoder = selectEncoder(req.caps, { lastFailed });
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
        try {
          await this.runPlan(req, plan, retried);
        } catch (err) {
          if (this.cancelled) throw new CancelError();
          if (encoder === "videotoolbox" && req.caps.x265 && isEncoderFailure(err)) {
            lastFailed = "videotoolbox";
            await removeTempFiles(this.temps);
            continue;
          }
          throw err;
        }

        const st = await stat(tempOut);
        if (exceedsTarget(st.size, targetBytes) && !retried) {
          retried = true;
          const nextBps = retryVideoBitrateBps(plan.videoBitrateBps, st.size, targetBytes);
          await removeTempFiles([tempOut]);
          const retryPlan = buildCommands({
            encoder,
            ffmpegPath: req.ffmpegPath,
            input: req.probe.path,
            output: tempOut,
            probe: req.probe,
            targetBytes,
            videoBps: nextBps,
            passLog,
          });
          req.hooks.onProgress({
            encoder,
            phase: "retry",
            ratio: 0,
            percent: 0,
            etaSec: null,
            message: "输出略超目标，正在按更低码率再压一次",
          });
          await this.runPlan(req, retryPlan, true);
        }

        const finalStat = await stat(tempOut);
        if (exceedsTarget(finalStat.size, targetBytes)) {
          await removeTempFiles(this.temps);
          this.running = false;
          req.hooks.onFail({
            message: `输出体积 ${formatMB(finalStat.size)} 超过目标 ${req.targetMB} MB，未保存结果。`,
          });
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
        const phase = plan.encoder === "x265" ? (index === 0 ? "pass1" : "pass2") : isRetry ? "retry" : "single";
        const message =
          phase === "pass1"
            ? "第一遍：分析画面，为第二遍编码做准备"
            : phase === "pass2"
              ? "第二遍：按目标大小编码为 1080p HEVC"
              : "正在编码为 1080p HEVC";
        const started = Date.now();
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

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
