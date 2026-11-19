import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectEncoder } from "../../shared/encoder";
import { estimateSizeMB, sampleRanges } from "../../shared/quality";
import { displaySize, scaleFilter } from "../../shared/scale";
import type { AnalysisProgress, EncoderCaps, EncoderKind, ProbeInfo, QualityAnalysis } from "../../shared/types";
import { buildCommands } from "./bitrate-cmd";
import { probeFile } from "./probe";

interface AnalyzeRequest {
  ffmpeg: string;
  ffprobe: string;
  probe: ProbeInfo;
  caps: EncoderCaps;
  onProgress: (progress: AnalysisProgress) => void;
}

interface Reference {
  path: string;
  probe: ProbeInfo;
}

class AnalysisCancelled extends Error {
  constructor() { super("已取消画质分析。"); }
}

class VideoToolboxFailure extends Error {}

/** 与没填时的正式压缩使用同一条清晰度优先命令。结果只外推体积，不回填上限。 */
export class QualityAnalyzer {
  private child: ChildProcess | null = null;
  private running = false;
  private cancelled = false;
  private finished: Promise<void> | null = null;
  private finish: (() => void) | null = null;

  get isRunning(): boolean { return this.running; }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    this.stopChild();
    await this.finished;
  }

  private stopChild(): void {
    const child = this.child;
    if (!child?.pid) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1500).unref();
  }

  private checkCancelled(): void {
    if (this.cancelled) throw new AnalysisCancelled();
  }

  async run(req: AnalyzeRequest): Promise<QualityAnalysis> {
    if (this.running) throw new Error("画质分析正在进行中。");
    const ranges = sampleRanges(req.probe.durationSec);
    let encoder = selectEncoder(req.caps);
    if (!ranges.length) throw new Error("这段视频太短，无法抽样分析。");
    if (!encoder) throw new Error("本机没有可用的 HEVC 编码器，无法试压。");

    this.running = true;
    this.cancelled = false;
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
    let directory = "";
    try {
      const before = await stat(req.probe.path);
      if (before.size !== req.probe.sizeBytes) throw new Error("视频文件已发生变化，请重新选择。");
      directory = await mkdtemp(join(tmpdir(), "kuaiyaya-analysis-"));
      const total = ranges.length * 2;
      let completed = 0;
      const progress = (message: string): void => req.onProgress({ message, completed, total });
      const references: Reference[] = [];
      for (let i = 0; i < ranges.length; i++) {
        this.checkCancelled();
        progress(`正在提取第 ${i + 1}/${ranges.length} 个片段`);
        const range = ranges[i];
        if (!range) continue;
        const path = join(directory, `reference-${i}.mkv`);
        await this.execute(req.ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-y", "-ss", range.startSec.toFixed(3),
          "-i", req.probe.path, "-t", range.durationSec.toFixed(3), "-map", "0:v:0", "-an",
          "-vf", scaleFilter(displaySize(req.probe.width, req.probe.height, req.probe.rotation)),
          "-c:v", "ffv1", "-level", "3", path,
        ]);
        this.checkCancelled();
        const referenceProbe = await probeFile(req.ffprobe, path);
        references.push({ path, probe: referenceProbe });
        completed++;
      }
      let sampleBytes = 0;
      let sampleSeconds = 0;
      for (;;) {
        sampleBytes = 0;
        sampleSeconds = 0;
        try {
          for (let i = 0; i < references.length; i++) {
            const ref = references[i];
            if (!ref) continue;
            this.checkCancelled();
            progress(`正在按清晰度试压第 ${i + 1}/${references.length} 个片段`);
            const output = join(directory, `encoded-${i}.mp4`);
            const plan = buildCommands({
              encoder,
              ffmpegPath: req.ffmpeg,
              input: ref.path,
              output,
              probe: ref.probe,
              targetBytes: req.probe.sizeBytes,
              mode: "quality",
            });
            try {
              for (const args of plan.args) await this.execute(req.ffmpeg, args);
            } catch (err) {
              this.checkCancelled();
              if (encoder === "videotoolbox" && req.caps.x265) throw new VideoToolboxFailure();
              throw err;
            }
            const sampleStat = await stat(output);
            sampleBytes += sampleStat.size;
            sampleSeconds += ref.probe.durationSec;
            completed++;
            await rm(output, { force: true });
          }
          break;
        } catch (err) {
          this.checkCancelled();
          if (err instanceof VideoToolboxFailure) {
            encoder = "x265";
            completed = references.length;
            progress("硬件编码不可用，正在切换软件编码重新试压");
            continue;
          }
          throw err;
        }
      }
      this.checkCancelled();
      if (sampleSeconds <= 0) throw new Error("无法根据样片估计体积。");
      const after = await stat(req.probe.path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        throw new Error("分析期间视频文件发生变化，请重新选择。");
      }
      return {
        filePath: req.probe.path,
        encoder: encoder as EncoderKind,
        sampleCount: references.length,
        sampleDurationSec: references.reduce((sum, ref) => sum + ref.probe.durationSec, 0),
        estimatedMB: estimateSizeMB(sampleBytes, sampleSeconds, req.probe.durationSec, req.probe.hasAudio),
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.child = null;
      this.running = false;
      this.finish?.();
      this.finish = null;
      this.finished = null;
    }
  }

  private execute(binary: string, args: string[]): Promise<string> {
    this.checkCancelled();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let output = "";
      let timedOut = false;
      let settled = false;
      const collect = (buffer: Buffer): void => {
        output += buffer.toString("utf8");
        if (output.length > 200_000) output = output.slice(-100_000);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        timedOut = true;
        this.stopChild();
      }, 180_000);
      timer.unref();
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (this.cancelled) reject(new AnalysisCancelled());
        else if (error) reject(error);
        else resolve(output);
      };
      child.on("error", (err) => finish(err));
      child.on("close", (code) => finish(timedOut ? new Error("画质分析耗时过长，请重试。") : code === 0 ? undefined : new Error("试压或画质比较失败。")));
    });
  }
}
