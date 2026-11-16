import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

describe.skipIf(!hasFfmpeg)("libx265 quality pass", () => {
  let dir = "";

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("finishes in one pass and saves a playable HEVC file smaller than the input", async () => {
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-cmp-"));
    const input = join(dir, "sample.mp4");
    // 高码率原片，保证清晰度优先的一轮 CRF 结果仍小于原片；相对参考目标可大可小。
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
    const messages: string[] = [];
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean; exceededTarget: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: bins.ffmpeg,
        probe,
        targetMB,
        caps,
        hooks: {
          exists: (p) => existsSync(p),
          onProgress: (event) => messages.push(event.message),
          onDone: (e) => resolve({ outputPath: e.outputPath, outputBytes: e.outputBytes, retried: e.retried, exceededTarget: e.exceededTarget }),
          onFail: (e) => reject(new Error(e.message)),
        },
      });
    });

    expect(done.retried).toBe(false);
    expect(done.exceededTarget).toBe(done.outputBytes > targetBytesFromMB(targetMB));
    expect(done.outputBytes).toBeLessThan(orig);
    expect(done.outputBytes).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes("清晰度优先"))).toBe(true);
    expect(messages.some((message) => message.includes("再压") || message.includes("第一遍") || message.includes("按目标体积"))).toBe(false);
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

const sizeScript = `#!/bin/sh
echo run >> "__CALLS__"
for last do :; done
dd if=/dev/zero of="$last" bs=1048576 count=__COUNT__ 2>/dev/null
base=\${last%.partial}
touch "$base.x265pass-0.log" "$base.x265pass-0.log.mbtree" "$base.x265pass-0.log.cutree" "$base.x265pass.log" "$base.x265pass.log.mbtree" "$base.x265pass.log.cutree"
`;

it("saves one quality pass when the result exceeds the reference target but is smaller than the source", async () => {
  await withFakeFfmpeg(sizeScript.replace("__COUNT__", "2"), async (dir, executable, calls) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const sourceBytes = 5 * 1024 * 1024;
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const messages: string[] = [];
    const job = new CompressJob();
    const done = await new Promise<{ outputPath: string; outputBytes: number; retried: boolean; exceededTarget: boolean; encoder: string }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, sourceBytes),
        targetMB: 1,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: (event) => messages.push(event.message),
          onDone: (event) => resolve({
            outputPath: event.outputPath,
            outputBytes: event.outputBytes,
            retried: event.retried,
            exceededTarget: event.exceededTarget,
            encoder: event.encoder,
          }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });

    const output = join(dir, "input_720p.mp4");
    expect(done.outputPath).toBe(output);
    expect(done.outputBytes).toBe(2 * 1024 * 1024);
    expect(done.exceededTarget).toBe(true);
    expect(done.retried).toBe(false);
    expect(done.encoder).toBe("videotoolbox");
    expect((await readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(messages).toContain("正在按清晰度优先编码为 1280×720 HEVC");
    expect(messages.some((message) => message.includes("再压") || message.includes("第一遍") || message.includes("第二遍") || message.includes("按目标体积"))).toBe(false);
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

it("does not save a result that is not smaller than the source", async () => {
  await withFakeFfmpeg(sizeScript.replace("__COUNT__", "5"), async (dir, executable, calls) => {
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
    expect(failure).toBe("压缩后体积未小于原片，未保存结果；原片没有改动。");
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
    const done = await new Promise<{ encoder: string; retried: boolean; exceededTarget: boolean }>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, 5 * 1024 * 1024),
        targetMB: 1,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: () => undefined,
          onDone: (event) => resolve({ encoder: event.encoder, retried: event.retried, exceededTarget: event.exceededTarget }),
          onFail: (event) => reject(new Error(event.message)),
        },
      });
    });
    expect(done.encoder).toBe("x265");
    expect(done.retried).toBe(false);
    expect(done.exceededTarget).toBe(false);
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual(["vt", "x265"]);
    expect((await stat(join(dir, "input_720p.mp4"))).size).toBe(100 * 1024);
    expect(await readFile(input, "utf8")).toBe("original-bytes");
  });
});
