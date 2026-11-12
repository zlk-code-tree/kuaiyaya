import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetBytesFromMB, videoBitrateBps } from "../../shared/bitrate";
import { selectEncoder } from "../../shared/encoder";
import { candidateTargets, estimateSizeMB, lowBitrateBudget, passesQualityHeuristic, preferSoftware, recommendCandidate, sampleRanges } from "../../shared/quality";
import { displaySize, scaleFilter } from "../../shared/scale";
import type { AnalysisProgress, EncoderCaps, ProbeInfo, QualityAnalysis, QualityCandidate, QualityMetric } from "../../shared/types";
import { buildCommands } from "./bitrate-cmd";
import { probeFile } from "./probe";

interface AnalyzeRequest {
  ffmpeg: string;
  ffprobe: string;
  probe: ProbeInfo;
  targetMB: number;
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

/** 与完整压缩使用相同的编码器、码率计算和尺寸；分析输出仅存在临时目录。 */
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
    const targets = candidateTargets(req.targetMB, req.probe.sizeBytes);
    const ranges = sampleRanges(req.probe.durationSec);
    if (!targets.length || !ranges.length) throw new Error("目标大小无效，请重新选择。");
    let encoder = selectEncoder(req.caps);
    if (!encoder) throw new Error("本机没有可用的 HEVC 编码器，无法试压。");

    this.running = true;
    this.cancelled = false;
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
    let directory = "";
    try {
      const before = await stat(req.probe.path);
      if (before.size !== req.probe.sizeBytes) throw new Error("视频文件已发生变化，请重新选择。");
      directory = await mkdtemp(join(tmpdir(), "kuaiyaya-analysis-"));
      const total = ranges.length * (1 + targets.length * 2);
      let completed = 0;
      const progress = (message: string): void => req.onProgress({ message, completed, total });
      const references: Reference[] = [];
      for (let i = 0; i < ranges.length; i++) {
        this.checkCancelled();
        progress(`正在提取第 ${i + 1}/${ranges.length} 个片段`);
        const range = ranges[i];
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
      const filters = await this.execute(req.ffmpeg, ["-hide_banner", "-filters"]);
      let metric: QualityMetric = /\blibvmaf\s/.test(filters) ? "vmaf" : "ssim";
      let metricConfirmed = false;
      let candidates: QualityCandidate[];
      let hardwareCandidates: QualityCandidate[] | null = null;
      for (;;) {
        const scores = targets.map(() => [] as number[]);
        const sizes = targets.map(() => 0);
        const sampleSeconds = targets.map(() => 0);
        try {
          for (let i = 0; i < references.length; i++) {
            const ref = references[i];
            for (let j = 0; j < targets.length; j++) {
              this.checkCancelled();
              progress(`正在试压第 ${i + 1}/${references.length} 个片段 · 目标 ${targets[j]} MB`);
              const output = join(directory, `encoded-${i}-${j}.mp4`);
              const passLog = join(directory, `pass-${i}-${j}`);
              const bps = videoBitrateBps({
                targetBytes: targetBytesFromMB(targets[j]),
                durationSec: req.probe.durationSec,
                hasAudio: req.probe.hasAudio,
              });
              const plan = buildCommands({
                encoder, ffmpegPath: req.ffmpeg, input: ref.path, output, probe: ref.probe,
                targetBytes: targetBytesFromMB(targets[j]), videoBps: bps, passLog,
              });
              try {
                for (const args of plan.args) await this.execute(req.ffmpeg, args);
              } catch (err) {
                this.checkCancelled();
                if (encoder === "videotoolbox" && req.caps.x265) throw new VideoToolboxFailure();
                throw err;
              }
              const sampleStat = await stat(output);
              sizes[j] += sampleStat.size;
              sampleSeconds[j] += ref.probe.durationSec;
              completed++;
              progress(`正在比较第 ${i + 1}/${references.length} 个片段 · 目标 ${targets[j]} MB`);
              let score: number;
              try {
                score = await this.measure(req.ffmpeg, output, ref.path, metric);
                metricConfirmed = true;
              } catch (err) {
                this.checkCancelled();
                if (metric !== "vmaf" || metricConfirmed) throw err;
                metric = "ssim";
                score = await this.measure(req.ffmpeg, output, ref.path, metric);
                metricConfirmed = true;
              }
              scores[j].push(score);
              completed++;
              await rm(output, { force: true });
            }
          }
          candidates = targets.map((targetMB, index) => ({
            targetMB,
            lowBitrateBudget: lowBitrateBudget(targetMB, req.probe.durationSec, req.probe.hasAudio),
            estimatedMB: estimateSizeMB(sizes[index], sampleSeconds[index], req.probe.durationSec, req.probe.hasAudio),
            lowestScore: Math.min(...scores[index]),
            averageScore: scores[index].reduce((sum, score) => sum + score, 0) / scores[index].length,
          }));
          if (encoder === "videotoolbox" && req.caps.x265 && !candidates.some((item) => !item.lowBitrateBudget && passesQualityHeuristic(metric, item.lowestScore))) {
            hardwareCandidates = candidates;
            encoder = "x265";
            completed = references.length;
            progress("样片仍有画质风险，正在尝试另一种编码方式");
            continue;
          }
          if (hardwareCandidates && !preferSoftware(metric, hardwareCandidates, candidates)) {
            candidates = hardwareCandidates;
            encoder = "videotoolbox";
          }
          break;
        } catch (err) {
          this.checkCancelled();
          if (err instanceof VideoToolboxFailure) {
            encoder = "x265";
            // 重新测量全部选项，保证分析与后续压缩使用同一编码器。
            completed = references.length;
            progress("硬件编码不可用，正在切换软件编码重新试压");
            continue;
          }
          if (!hardwareCandidates) throw err;
          // 补充试压失败时仍可使用已经完成的硬编码分析。
          candidates = hardwareCandidates;
          encoder = "videotoolbox";
          break;
        }
      }
      this.checkCancelled();
      const after = await stat(req.probe.path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
        throw new Error("分析期间视频文件发生变化，请重新选择。");
      }
      const recommended = recommendCandidate(metric, candidates);
      return {
        filePath: req.probe.path,
        encoder,
        metric,
        sampleCount: references.length,
        sampleDurationSec: references.reduce((sum, ref) => sum + ref.probe.durationSec, 0),
        candidates,
        recommendedTargetMB: recommended.targetMB,
        meetsHeuristic: !recommended.lowBitrateBudget && passesQualityHeuristic(metric, recommended.lowestScore),
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

  private async measure(ffmpeg: string, encoded: string, reference: string, metric: QualityMetric): Promise<number> {
    const filter = metric === "vmaf" ? "libvmaf=n_threads=2" : "ssim";
    const output = await this.execute(ffmpeg, [
      "-hide_banner", "-i", encoded, "-i", reference,
      "-filter_complex", `[0:v]setpts=PTS-STARTPTS,format=yuv420p[dist];[1:v]setpts=PTS-STARTPTS,format=yuv420p[ref];[dist][ref]${filter}`,
      "-an", "-f", "null", "-",
    ]);
    const match = metric === "vmaf" ? /VMAF score:\s*([\d.]+)/i.exec(output) : /All:\s*([\d.]+)/i.exec(output);
    const score = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(score)) throw new Error("无法读取画质对比结果。");
    return score;
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
