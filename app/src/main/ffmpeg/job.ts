import { spawn, type ChildProcess } from "node:child_process";
import { rename, stat } from "node:fs/promises";
import type { DoneEvent, EncoderCaps, EncoderKind, FailEvent, OutputPlan, ProbeInfo, ProgressEvent } from "../../shared/types";
import { exceedsTarget, retryVideoBitrateBps, targetBytesFromMB } from "../../shared/bitrate";
import { selectEncoder } from "../../shared/encoder";
import { MSG } from "../../shared/messages";
import { allocateOutputPath, partialPath, passLogPrefix } from "../../shared/output-name";
import { displaySize, fitOutput, outputLabel } from "../../shared/scale";
import { buildCommands, type CommandPlan } from "./bitrate-cmd";
import { removeTempFiles } from "./cleanup";
import { etaSeconds, parseProgressLine, ratioFromOutTime } from "./progress";

/** 同时开压时，文件还没落地也不能抢同一个输出路径。 */
const reservedOutputs = new Set<string>();

export interface JobHooks {
  onProgress: (e: ProgressEvent) => void;
  onDone: (e: DoneEvent) => void;
  onFail: (e: FailEvent) => void;
  exists: (p: string) => boolean;
}

export interface JobRequest {
  ffmpegPath: string;
  probe: ProbeInfo;
  /** null：只走清晰度优先。正整数：上限，先清晰度优先，超了再按码率收。 */
  targetMB: number | null;
  output?: OutputPlan | null;
  caps: EncoderCaps;
  preferredEncoder?: EncoderKind;
  hooks: JobHooks;
}

type EncodeIntent = "quality" | "cap" | "retry";

interface PassResult {
  bytes: number;
  encoder: EncoderKind;
  videoBitrateBps: number;
}

interface AttemptPaths {
  outputPath: string;
  tempOut: string;
  passLog: string;
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
    const capBytes = req.targetMB == null ? null : targetBytesFromMB(req.targetMB);
    const outSize = fitOutput(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
    let outputPath: string;
    try {
      outputPath = allocateOutputPath(req.probe.path, req.hooks.exists, outSize, req.output, reservedOutputs);
    } catch {
      this.running = false;
      req.hooks.onFail({ message: "无法分配不冲突的输出文件名" });
      return;
    }
    const paths: AttemptPaths = {
      outputPath,
      tempOut: partialPath(outputPath),
      passLog: passLogPrefix(outputPath),
    };
    this.temps.push(paths.tempOut, paths.passLog);

    const caps = req.preferredEncoder === "x265" && req.caps.x265
      ? { ...req.caps, videotoolbox: false }
      : req.caps;

    try {
      if (!selectEncoder(caps)) {
        this.running = false;
        req.hooks.onFail({ message: "本机没有可用的 HEVC 编码器。" });
        return;
      }

      const quality = await this.encode(req, caps, paths, "quality");
      const qualityDecision = decideOutput(quality.bytes, req.probe.sizeBytes, capBytes);
      if (qualityDecision === "not-smaller") {
        await this.failUnsaved(req, MSG.notSmaller);
        return;
      }
      if (qualityDecision === "keep") {
        await this.finish(req, paths, quality, false, false);
        return;
      }

      await removeTempFiles(this.temps);
      const constrained = await this.encode(req, caps, paths, "cap");
      const constrainedDecision = decideOutput(constrained.bytes, req.probe.sizeBytes, capBytes);
      if (constrainedDecision === "not-smaller") {
        await this.failUnsaved(req, MSG.notSmaller);
        return;
      }
      if (constrainedDecision === "keep") {
        await this.finish(req, paths, constrained, true, false);
        return;
      }

      const retryBps = retryVideoBitrateBps(constrained.videoBitrateBps, constrained.bytes, capBytes ?? constrained.bytes);
      await removeTempFiles(this.temps);
      const retried = await this.encode(req, caps, paths, "retry", retryBps);
      const retryDecision = decideOutput(retried.bytes, req.probe.sizeBytes, capBytes);
      if (retryDecision === "not-smaller") {
        await this.failUnsaved(req, MSG.notSmaller);
        return;
      }
      if (retryDecision === "keep") {
        await this.finish(req, paths, retried, true, true);
        return;
      }
      await this.failUnsaved(req, MSG.missedCap);
    } catch (err) {
      await removeTempFiles(this.temps);
      this.running = false;
      if (this.cancelled || err instanceof CancelError) {
        req.hooks.onFail({ message: MSG.cancelled, cancelled: true });
        return;
      }
      req.hooks.onFail({
        message: err instanceof Error && err.message === "encoder unavailable"
          ? "编码器不可用，压缩未能完成。原片没有被修改，临时文件已清理。"
          : MSG.encodeFail,
      });
    } finally {
      reservedOutputs.delete(outputPath);
    }
  }

  private async encode(
    req: JobRequest,
    caps: EncoderCaps,
    paths: AttemptPaths,
    intent: EncodeIntent,
    videoBps?: number,
  ): Promise<PassResult> {
    let lastFailed: EncoderKind | undefined;
    const targetBytes = req.targetMB == null ? req.probe.sizeBytes : targetBytesFromMB(req.targetMB);
    for (;;) {
      if (this.cancelled) throw new CancelError();
      const encoder = selectEncoder(caps, { lastFailed });
      if (!encoder) throw new Error("encoder unavailable");
      const plan = buildCommands({
        encoder,
        ffmpegPath: req.ffmpegPath,
        input: req.probe.path,
        output: paths.tempOut,
        probe: req.probe,
        targetBytes,
        passLog: paths.passLog,
        videoBps,
        mode: intent === "quality" ? "quality" : "bitrate",
      });
      try {
        await this.runPlan(req, plan, intent);
      } catch (err) {
        if (this.cancelled) throw new CancelError();
        if (encoder === "videotoolbox" && req.caps.x265 && isEncoderFailure(err)) {
          lastFailed = "videotoolbox";
          await removeTempFiles(this.temps);
          continue;
        }
        throw err;
      }
      if (this.cancelled) throw new CancelError();
      const finalStat = await stat(paths.tempOut);
      if (this.cancelled) throw new CancelError();
      return { bytes: finalStat.size, encoder, videoBitrateBps: plan.videoBitrateBps };
    }
  }

  private async finish(
    req: JobRequest,
    paths: AttemptPaths,
    result: PassResult,
    qualityReduced: boolean,
    retried: boolean,
  ): Promise<void> {
    if (this.cancelled) throw new CancelError();
    await rename(paths.tempOut, paths.outputPath);
    await removeTempFiles([paths.passLog]);
    this.running = false;
    req.hooks.onDone({
      outputPath: paths.outputPath,
      inputBytes: req.probe.sizeBytes,
      outputBytes: result.bytes,
      savedBytes: Math.max(0, req.probe.sizeBytes - result.bytes),
      encoder: result.encoder,
      retried,
      qualityReduced,
      elapsedSec: this.elapsedSec(),
    });
  }

  private async failUnsaved(req: JobRequest, message: string): Promise<void> {
    await removeTempFiles(this.temps);
    this.running = false;
    req.hooks.onFail({ message });
  }

  private runPlan(req: JobRequest, plan: CommandPlan, intent: EncodeIntent): Promise<void> {
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
        const phase = twoPass ? (index === 0 ? "pass1" : "pass2") : intent === "retry" ? "retry" : "single";
        const dim = outputLabel(displaySize(req.probe.width, req.probe.height, req.probe.rotation));
        const message = progressMessage(intent, phase, dim);
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

function decideOutput(bytes: number, sourceBytes: number, capBytes: number | null): "not-smaller" | "keep" | "over-cap" {
  if (bytes >= sourceBytes) return "not-smaller";
  if (capBytes == null || !exceedsTarget(bytes, capBytes)) return "keep";
  return "over-cap";
}

function progressMessage(intent: EncodeIntent, phase: ProgressEvent["phase"], dim: string): string {
  if (intent === "quality") return `正在按清晰度优先编码为 ${dim} HEVC`;
  if (phase === "pass1") return "第一遍：分析画面，为按目标上限编码做准备";
  if (phase === "pass2") return `第二遍：按目标上限编码为 ${dim} HEVC`;
  if (intent === "retry") return `正在按更低码率重试，压到目标上限以内（${dim} HEVC）`;
  return `正在按目标上限编码为 ${dim} HEVC`;
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
