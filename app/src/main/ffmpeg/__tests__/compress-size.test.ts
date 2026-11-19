import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { retryVideoBitrateBps, targetBytesFromMB, videoBitrateBps } from "../../../shared/bitrate";
import { MSG } from "../../../shared/messages";
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

describe.skipIf(!hasFfmpeg)("libx265 quality pass", () => {
  let dir = "";

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("finishes in one pass and saves a playable HEVC file smaller than the input", async () => {
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-cmp-"));
    const input = join(dir, "sample.mp4");
    // 高码率原片，保证没填时的一轮清晰度优先结果仍小于原片。
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
        "-b:v",
        "10M",
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
    const caps: EncoderCaps = {
      x265: true,
      videotoolbox: false,
      ffmpegVersion: "test",
      probedAt: new Date().toISOString(),
      ffmpegPath: bins.ffmpeg,
    };

    const job = new CompressJob();
    const messages: string[] = [];
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean; qualityReduced: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: bins.ffmpeg,
        probe,
        targetMB: null,
        caps,
        hooks: {
          exists: (p) => existsSync(p),
          onProgress: (event) => messages.push(event.message),
          onDone: (e) => resolve({ outputPath: e.outputPath, outputBytes: e.outputBytes, retried: e.retried, qualityReduced: e.qualityReduced }),
          onFail: (e) => reject(new Error(e.message)),
        },
      });
    });

    expect(done.retried).toBe(false);
    expect(done.qualityReduced).toBe(false);
    expect(done.outputBytes).toBeLessThan(orig);
    expect(done.outputBytes).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes("清晰度优先"))).toBe(true);
    expect(messages.some((message) => message.includes("按目标上限") || message.includes("再压") || message.includes("第一遍"))).toBe(false);
    const names = await readdir(dir);
    expect(names.some((name) => name.includes("cutree") || name.includes("x265pass") || name.endsWith(".partial"))).toBe(false);
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
    expect((await stat(input)).size).toBe(orig);
  }, 120_000);
});

function probeFor(input: string, sizeBytes: number): ProbeInfo {
  return {
    path: input,
    name: "input.mp4",
    sizeBytes,
    durationSec: 30,
    width: 1280,
    height: 720,
    rotation: 0,
    displayWidth: 1280,
    displayHeight: 720,
    videoCodec: "h264",
    hasAudio: false,
    container: "mp4",
  };
}

async function withFakeFfmpeg(
  script: string,
  run: (dir: string, executable: string, calls: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-fake-"));
  try {
    const executable = join(dir, "fake-ffmpeg");
    const calls = join(dir, "calls");
    await writeFile(executable, script.replaceAll("__CALLS__", calls));
    await chmod(executable, 0o755);
    await run(dir, executable, calls);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sizedScript(opts: { quality: number; bitrate: number; retry: number; retryBelow: number }): string {
  return `#!/bin/sh
mode=quality
prev=
bps=
for arg in "$@"; do
  if [ "$prev" = "-b:v" ]; then
    mode=bitrate
    bps=$arg
  fi
  prev=$arg
done
if [ "$mode" = "bitrate" ]; then
  echo "bitrate $bps" >> "__CALLS__"
else
  echo quality >> "__CALLS__"
fi
for last do :; done
count=${opts.quality}
if [ "$mode" = "bitrate" ]; then
  count=${opts.bitrate}
  if [ -n "$bps" ] && [ "$bps" -lt ${opts.retryBelow} ]; then
    count=${opts.retry}
  fi
fi
dd if=/dev/zero of="$last" bs=1048576 count=$count 2>/dev/null
base=\${last%.partial}
touch "$base.x265pass-0.log" "$base.x265pass-0.log.mbtree" "$base.x265pass-0.log.cutree" "$base.x265pass.log" "$base.x265pass.log.mbtree" "$base.x265pass.log.cutree"
`;
}

const onePass = sizedScript({ quality: 2, bitrate: 2, retry: 2, retryBelow: 1 });

it("keeps one quality pass when the field is empty, even if a half-size cap would have been smaller", async () => {
  await withFakeFfmpeg(onePass, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const sourceBytes = 5 * 1024 * 1024;
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const messages: string[] = [];
    const job = new CompressJob();
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean; qualityReduced: boolean; encoder: string }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, sourceBytes),
        targetMB: null,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: (event) => messages.push(event.message),
          onDone: (event) => resolve({
            outputPath: event.outputPath,
            outputBytes: event.outputBytes,
            retried: event.retried,
            qualityReduced: event.qualityReduced,
            encoder: event.encoder,
          }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });

    const output = join(dir, "input_720p.mp4");
    const log = (await readFile(calls, "utf8")).trim().split("\n");
    expect(done.outputPath).toBe(output);
    expect(done.outputBytes).toBe(2 * 1024 * 1024);
    expect(done.qualityReduced).toBe(false);
    expect(done.retried).toBe(false);
    expect(done.encoder).toBe("videotoolbox");
    expect(log).toEqual(["quality"]);
    expect(messages).toContain("正在按清晰度优先编码为 1280×720 HEVC");
    expect(messages.some((message) => message.includes("按目标上限") || message.includes("第一遍") || message.includes("第二遍"))).toBe(false);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
    expect((await stat(output)).size).toBe(2 * 1024 * 1024);
    for (const name of [
      `${output}.partial`,
      `${output}.x265pass-0.log`,
      `${output}.x265pass-0.log.mbtree`,
      `${output}.x265pass-0.log.cutree`,
      `${output}.x265pass.log`,
      `${output}.x265pass.log.mbtree`,
      `${output}.x265pass.log.cutree`,
    ]) {
      expect(existsSync(name)).toBe(false);
    }
  });
});

it("keeps the smaller quality-first file when it is already within the cap", async () => {
  await withFakeFfmpeg(onePass, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const done = await new Promise<{ outputBytes: number; qualityReduced: boolean; retried: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: 4,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: (event) => resolve({ outputBytes: event.outputBytes, qualityReduced: event.qualityReduced, retried: event.retried }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });
    expect(done.outputBytes).toBe(2 * 1024 * 1024);
    expect(done.qualityReduced).toBe(false);
    expect(done.retried).toBe(false);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["quality"]);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});

it("saves a lower-bitrate retry when the quality pass and the first cap pass are still over the cap", async () => {
  const cap = 1;
  const sourceBytes = 5 * 1024 * 1024;
  const firstBps = videoBitrateBps({ targetBytes: targetBytesFromMB(cap), durationSec: 30, hasAudio: false });
  const retryBps = retryVideoBitrateBps(firstBps, 2 * 1024 * 1024, targetBytesFromMB(cap));
  expect(retryBps).toBeLessThan(firstBps);
  const script = sizedScript({ quality: 2, bitrate: 2, retry: 1, retryBelow: retryBps + 1 });
  await withFakeFfmpeg(script, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const messages: string[] = [];
    const job = new CompressJob();
    const done = await new Promise<{ outputBytes: number; qualityReduced: boolean; retried: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, sourceBytes),
        targetMB: cap,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: (event) => messages.push(event.message),
          onDone: (event) => resolve({ outputBytes: event.outputBytes, qualityReduced: event.qualityReduced, retried: event.retried }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });
    const log = (await readFile(calls, "utf8")).trim().split("\n");
    expect(log[0]).toBe("quality");
    expect(log[1]).toBe(`bitrate ${firstBps}`);
    expect(log[2]).toBe(`bitrate ${retryBps}`);
    expect(log).toHaveLength(3);
    expect(done.outputBytes).toBe(1024 * 1024);
    expect(done.qualityReduced).toBe(true);
    expect(done.retried).toBe(true);
    expect(messages[0]).toContain("清晰度优先");
    expect(messages.some((message) => message.includes("按目标上限"))).toBe(true);
    expect(messages.some((message) => message.includes("更低码率"))).toBe(true);
    expect(existsSync(`${join(dir, "input_720p.mp4")}.partial`)).toBe(false);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});

it("does not save when two cap passes stay above the cap but below the source", async () => {
  const script = sizedScript({ quality: 3, bitrate: 2, retry: 2, retryBelow: 1 });
  await withFakeFfmpeg(script, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const failure = await new Promise<string>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: 1,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: () => reject(new Error("over-cap result was saved")),
          onFail: (event) => resolve(event.message),
        },
      });
    });
    const output = join(dir, "input_720p.mp4");
    expect(failure).toBe(MSG.missedCap);
    expect(failure).not.toContain("未小于原片");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(3);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});

it("uses the not-smaller failure when a cap pass is not smaller than the source", async () => {
  const script = sizedScript({ quality: 2, bitrate: 5, retry: 1, retryBelow: 1 });
  await withFakeFfmpeg(script, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const failure = await new Promise<string>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: 1,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: () => reject(new Error("result that is not smaller was saved")),
          onFail: (event) => resolve(event.message),
        },
      });
    });
    expect(failure).toBe(MSG.notSmaller);
    expect(failure).not.toContain("未能压到目标体积");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(existsSync(join(dir, "input_720p.mp4"))).toBe(false);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});

it("does not save a result that is not smaller than the source", async () => {
  const script = sizedScript({ quality: 5, bitrate: 5, retry: 5, retryBelow: 1 });
  await withFakeFfmpeg(script, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const failure = await new Promise<string>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: 1,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: () => reject(new Error("result that is not smaller was saved")),
          onFail: (event) => resolve(event.message),
        },
      });
    });
    const output = join(dir, "input_720p.mp4");
    expect(failure).toBe(MSG.notSmaller);
    expect(failure).not.toContain("未能压到目标体积");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.partial`)).toBe(false);
    expect(existsSync(`${output}.x265pass-0.log.cutree`)).toBe(false);
    expect(existsSync(`${output}.x265pass.log.cutree`)).toBe(false);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});

it("falls back from a failed VideoToolbox pass to one libx265 quality pass", async () => {
  const script = `#!/bin/sh
if printf '%s\\n' "$@" | grep -q hevc_videotoolbox; then
  echo vt >> "__CALLS__"
  echo "Error while opening encoder" >&2
  exit 1
fi
echo x265 >> "__CALLS__"
if printf '%s\\n' "$@" | grep -q -- '-b:v'; then
  echo bitrate >> "__CALLS__"
fi
for last do :; done
dd if=/dev/zero of="$last" bs=1024 count=100 2>/dev/null
`;
  await withFakeFfmpeg(script, async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: true, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    const done = await new Promise<{ encoder: string; retried: boolean; qualityReduced: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: null,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: (event) => resolve({ encoder: event.encoder, retried: event.retried, qualityReduced: event.qualityReduced }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });
    expect(done.encoder).toBe("x265");
    expect(done.retried).toBe(false);
    expect(done.qualityReduced).toBe(false);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["vt", "x265"]);
    expect((await stat(join(dir, "input_720p.mp4"))).size).toBe(100 * 1024);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});
