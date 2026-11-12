import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EncoderCaps, ProbeInfo } from "../../../shared/types";
import { QualityAnalyzer } from "../quality-analysis";
import { probeFile } from "../probe";

const hasFfmpeg = (() => {
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return encoders.includes("libx264") && encoders.includes("libx265") && encoders.includes("ffv1");
  } catch { return false; }
})();

const caps: EncoderCaps = { x265: true, videotoolbox: false, ffmpegVersion: "test", probedAt: "", ffmpegPath: "ffmpeg" };

describe.skipIf(!hasFfmpeg)("quality analysis with ffmpeg", () => {
  it("compares multiple real encoded samples and returns usable recommendations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-test-input-"));
    try {
      const path = join(dir, "video.mp4");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=9",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", path,
      ]);
      const probe = await probeFile("ffprobe", path);
      expect(probe.sizeBytes).toBeGreaterThan(2 * 1024 * 1024);
      const events: string[] = [];
      const result = await new QualityAnalyzer().run({
        ffmpeg: "ffmpeg", ffprobe: "ffprobe", probe, targetMB: 1, caps,
        onProgress: (event) => events.push(event.message),
      });
      expect(result.sampleCount).toBe(3);
      expect(result.encoder).toBe("x265");
      expect(["vmaf", "ssim"]).toContain(result.metric);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].targetMB).toBe(1);
      expect(result.candidates.every((candidate) => Number.isFinite(candidate.lowestScore) && candidate.estimatedMB > 0)).toBe(true);
      expect(result.candidates.map((candidate) => candidate.targetMB)).toContain(result.recommendedTargetMB);
      expect(events.some((event) => event.includes("正在比较"))).toBe(true);
      expect((await stat(path)).size).toBe(probe.sizeBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("falls back to SSIM when the VMAF filter is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-test-ssim-"));
    try {
      const path = join(dir, "short.mp4");
      const wrapper = join(dir, "ffmpeg-without-vmaf");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "4", "-pix_fmt", "yuv420p", path,
      ]);
      // Force VMAF to fail even on builds which expose it, so the actual fallback is exercised.
      await writeFile(wrapper, '#!/bin/sh\nfor arg do case "$arg" in *libvmaf=n_threads=2*) exit 1;; esac; done\nexec ffmpeg "$@"\n');
      await chmod(wrapper, 0o755);
      const probe = await probeFile("ffprobe", path);
      expect(probe.sizeBytes).toBeGreaterThan(1024 * 1024);
      const result = await new QualityAnalyzer().run({
        ffmpeg: wrapper, ffprobe: "ffprobe", probe, targetMB: 1, caps,
        onProgress: () => undefined,
      });
      expect(result.metric).toBe("ssim");
      expect(result.sampleCount).toBe(1);
      expect(result.candidates.every((candidate) => candidate.lowestScore > 0 && candidate.lowestScore <= 1)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

it("cancels the running subprocess and removes its temporary files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-test-cancel-"));
  const existing = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("kuaiyaya-analysis-")));
  try {
    const input = join(dir, "input.mp4");
    const ffmpeg = join(dir, "wait-ffmpeg");
    await writeFile(input, "source");
    await writeFile(ffmpeg, "#!/bin/sh\nexec sleep 60\n");
    await chmod(ffmpeg, 0o755);
    const probe: ProbeInfo = {
      path: input, name: "input.mp4", sizeBytes: 6, durationSec: 10,
      width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360,
      videoCodec: "h264", hasAudio: false, container: "mp4",
    };
    // 让目标大小通过规划校验，同时不更改实际源文件大小。
    await writeFile(input, Buffer.alloc(3 * 1024 * 1024));
    probe.sizeBytes = (await stat(input)).size;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const analyzer = new QualityAnalyzer();
    const run = analyzer.run({ ffmpeg, ffprobe: "ffprobe", probe, targetMB: 1, caps, onProgress: began });
    const result = run.then(() => "success", (error: Error) => error.message);
    await started;
    await analyzer.cancel();
    expect(await result).toContain("已取消");
    expect(analyzer.isRunning).toBe(false);
    const remaining = (await readdir(tmpdir())).filter((name) => name.startsWith("kuaiyaya-analysis-") && !existing.has(name));
    expect(remaining).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
