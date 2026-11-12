import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { targetBytesFromMB } from "../../../shared/bitrate";
import type { EncoderCaps, ProbeInfo } from "../../../shared/types";
import { CompressJob } from "../job";
import { probeFile } from "../probe";
import { resolveBinaries } from "../binary";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("libx265 size cap", () => {
  let dir = "";

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("saves a playable HEVC result within the target and smaller than the input", async () => {
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-cmp-"));
    const input = join(dir, "sample.mp4");
    // 约 3 秒、720p 彩条+噪声，软编可以压到明显小于原片。
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=25:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        input,
      ],
      { stdio: "ignore" },
    );

    const bins = await resolveBinaries();
    const probe: ProbeInfo = await probeFile(bins.ffprobe, input);
    const orig = (await stat(input)).size;
    // 目标取原大小一半（四舍五入到整数 MB，至少 1MB）
    let targetMB = Math.max(1, Math.round(orig / (1024 * 1024) / 2));
    if (targetMB * 1024 * 1024 >= orig) targetMB = 1;
    const caps: EncoderCaps = {
      x265: true,
      videotoolbox: false,
      ffmpegVersion: "test",
      probedAt: new Date().toISOString(),
      ffmpegPath: bins.ffmpeg,
    };

    const job = new CompressJob();
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean; exceededTarget: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: bins.ffmpeg,
        probe,
        targetMB,
        caps,
        hooks: {
          exists: (p) => existsSync(p),
          onProgress: () => undefined,
          onDone: (e) => resolve({ outputPath: e.outputPath, outputBytes: e.outputBytes, retried: e.retried, exceededTarget: e.exceededTarget }),
          onFail: (e) => reject(new Error(e.message)),
        },
      });
    });

    expect(done.exceededTarget).toBe(false);
    expect(done.outputBytes).toBeLessThanOrEqual(targetBytesFromMB(targetMB));
    expect(done.outputBytes).toBeLessThan(orig);
    expect(done.outputBytes).toBeGreaterThan(0);
    const info = execFileSync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,codec_tag_string",
      "-of",
      "json",
      done.outputPath,
    ]).toString("utf8");
    expect(info).toMatch(/hevc|h265/i);
    expect(info).toMatch(/hvc1/i);
  }, 120_000);
});

it("retries an oversized output once and does not save it if it still exceeds the target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-oversize-"));
  try {
    const executable = join(dir, "fake-ffmpeg");
    const calls = join(dir, "calls");
    await writeFile(executable, `#!/bin/sh\necho run >> "${calls}"\nfor last do :; done\ndd if=/dev/zero of="$last" bs=1048576 count=2 2>/dev/null\n`);
    await chmod(executable, 0o755);
    const input = join(dir, "input.mp4");
    const probe: ProbeInfo = {
      path: input, name: "input.mp4", sizeBytes: 5 * 1024 * 1024,
      durationSec: 30, width: 1280, height: 720, rotation: 0,
      displayWidth: 1280, displayHeight: 720, videoCodec: "h264", hasAudio: false, container: "mp4",
    };
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const failure = await new Promise<string>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable, probe, targetMB: 1, caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: () => reject(new Error("oversized result was saved")),
          onFail: (event) => resolve(event.message),
        },
      });
    });
    expect(failure).toContain("未能压到目标体积");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(existsSync(join(dir, "input_720p.mp4"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
