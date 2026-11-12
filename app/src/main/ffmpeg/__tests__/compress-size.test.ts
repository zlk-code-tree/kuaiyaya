import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { exceedsTarget, targetBytesFromMB } from "../../../shared/bitrate";
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

describe.skipIf(!hasFfmpeg)("libx265 size cap on Linux", () => {
  let dir = "";

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps the output at or under the target size (不得超过), with at most one retry", async () => {
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
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: bins.ffmpeg,
        probe,
        targetMB,
        caps,
        hooks: {
          exists: (p) => existsSync(p),
          onProgress: () => undefined,
          onDone: (e) => resolve({ outputPath: e.outputPath, outputBytes: e.outputBytes, retried: e.retried }),
          onFail: (e) => reject(new Error(e.message)),
        },
      });
    });

    expect(exceedsTarget(done.outputBytes, targetBytesFromMB(targetMB))).toBe(false);
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
