import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { MSG } from "../../../shared/messages";
import type { DoneEvent, EncoderCaps, ProbeInfo } from "../../../shared/types";
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
    const done = await new Promise<DoneEvent>((resolve, reject) => {
      void job.run({
        ffmpegPath: bins.ffmpeg,
        probe,
        targetMB: null,
        caps,
        hooks: {
          exists: (p) => existsSync(p),
          onProgress: (event) => messages.push(event.message),
          onDone: (event) => resolve(event),
          onFail: (e) => reject(new Error(e.message)),
        },
      });
    });

    expect(done.retried).toBe(false);
    expect(done.qualityReduced).toBe(false);
    expect(done).not.toHaveProperty("exceededTarget");
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

function sizedScript(kib: number[]): string {
  const fallback = kib[kib.length - 1] ?? 1;
  const cases = kib.map((count, index) => `  ${index + 1}) count=${count} ;;`).join("\n");
  return `#!/bin/sh
printf '%s\\n' "$@" >> "__CALLS__"
echo '---' >> "__CALLS__"
n=$(grep -c '^---$' "__CALLS__")
count=${fallback}
case "$n" in
${cases}
esac
for last do :; done
dd if=/dev/zero of="$last" bs=1024 count="$count" 2>/dev/null
base=\${last%.partial}
touch "$base.x265pass-0.log" "$base.x265pass-0.log.mbtree" "$base.x265pass-0.log.cutree" "$base.x265pass.log" "$base.x265pass.log.mbtree" "$base.x265pass.log.cutree"
`;
}

function invocations(log: string): string[][] {
  return log.split(/^---$/m)
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
    .filter((args) => args.length > 0);
}

function bitrateOf(args: string[]): number | null {
  const index = args.indexOf("-b:v");
  return index >= 0 ? Number(args[index + 1]) : null;
}

const sourceBytes = 5 * 1024 * 1024;

async function runSized(
  kib: number[],
  targetMB: number | null,
  hooks: {
    onDone?: (event: DoneEvent) => void;
    onFail?: (message: string) => void;
    onProgress?: (message: string) => void;
    check?: (dir: string) => Promise<void>;
  },
): Promise<string[][]> {
  let calls: string[][] = [];
  await withFakeFfmpeg(sizedScript(kib), async (dir, executable, callLog) => {
    const input = join(dir, "input.mp4");
    await writeFile(input, "original-bytes");
    const caps: EncoderCaps = {
      x265: false, videotoolbox: true, ffmpegVersion: "test", probedAt: "", ffmpegPath: executable,
    };
    const job = new CompressJob();
    await new Promise<void>((resolve, reject) => {
      void job.run({
        ffmpegPath: executable,
        probe: probeFor(input, sourceBytes),
        targetMB,
        caps,
        hooks: {
          exists: existsSync,
          onProgress: (event) => hooks.onProgress?.(event.message),
          onDone: (event) => {
            hooks.onDone?.(event);
            resolve();
          },
          onFail: (event) => {
            hooks.onFail?.(event.message);
            resolve();
          },
        },
      }).catch(reject);
    });
    calls = invocations(await readFile(callLog, "utf8"));
    expect(await readFile(input, "utf8")).toBe("original-bytes");
    await hooks.check?.(dir);
  });
  return calls;
}

it("runs only one quality pass when the limit is empty", async () => {
  const messages: string[] = [];
  let done: DoneEvent | null = null;
  const calls = await runSized([2048], null, {
    onProgress: (message) => messages.push(message),
    onDone: (event) => { done = event; },
    onFail: (message) => { throw new Error(message); },
    check: async (dir) => {
      const output = join(dir, "input_720p.mp4");
      expect(done?.outputPath).toBe(output);
      expect((await stat(output)).size).toBe(2 * 1024 * 1024);
      expect(existsSync(`${output}.partial`)).toBe(false);
      expect(existsSync(`${output}.x265pass.log.cutree`)).toBe(false);
    },
  });
  expect(done).toMatchObject({
    outputBytes: 2 * 1024 * 1024,
    qualityReduced: false,
    retried: false,
    encoder: "videotoolbox",
  });
  expect(done).not.toHaveProperty("exceededTarget");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("-q:v");
  expect(calls[0]).toContain("70");
  expect(calls[0]).not.toContain("-b:v");
  expect(messages).toContain("正在按清晰度优先编码为 1280×720 HEVC");
  expect(messages.some((message) => message.includes("按目标上限") || message.includes("第一遍") || message.includes("第二遍"))).toBe(false);
});

it("keeps the smaller quality pass when it is already within the limit", async () => {
  let done: DoneEvent | null = null;
  const calls = await runSized([1024], 3, {
    onDone: (event) => { done = event; },
    onFail: (message) => { throw new Error(message); },
  });
  expect(done).toMatchObject({ outputBytes: 1024 * 1024, qualityReduced: false, retried: false });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("-q:v");
  expect(calls[0]).not.toContain("-b:v");
});

it("uses one bitrate pass when quality exceeds the limit and that pass fits", async () => {
  const messages: string[] = [];
  let done: DoneEvent | null = null;
  const calls = await runSized([3072, 1024], 1, {
    onProgress: (message) => messages.push(message),
    onDone: (event) => { done = event; },
    onFail: (message) => { throw new Error(message); },
  });
  expect(done).toMatchObject({ outputBytes: 1024 * 1024, qualityReduced: true, retried: false });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("-q:v");
  expect(calls[0]).not.toContain("-b:v");
  expect(calls[1]).toContain("-b:v");
  expect(calls[1]).toContain("-maxrate");
  expect(calls[1]).not.toContain("-q:v");
  expect(messages.some((message) => message.includes("正在按目标上限编码"))).toBe(true);
  expect(messages.filter((message) => message.includes("清晰度优先"))).toHaveLength(1);
});

it("retries the bitrate once and saves when that pass fits", async () => {
  let done: DoneEvent | null = null;
  const calls = await runSized([4096, 3072, 1024], 1, {
    onDone: (event) => { done = event; },
    onFail: (message) => { throw new Error(message); },
  });
  expect(done).toMatchObject({ outputBytes: 1024 * 1024, qualityReduced: true, retried: true });
  expect(calls).toHaveLength(3);
  const first = bitrateOf(calls[1] ?? []);
  const second = bitrateOf(calls[2] ?? []);
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second ?? 0).toBeLessThan(first ?? 0);
  expect(calls.filter((args) => args.includes("-q:v"))).toHaveLength(1);
});

it("does not save when two constrained passes stay above the limit", async () => {
  let failure = "";
  const calls = await runSized([2048, 2048, 2048], 1, {
    onDone: () => { throw new Error("over-limit result was saved"); },
    onFail: (message) => { failure = message; },
    check: async (dir) => {
      expect(existsSync(join(dir, "input_720p.mp4"))).toBe(false);
      expect(existsSync(join(dir, "input_720p.mp4.partial"))).toBe(false);
    },
  });
  expect(failure).toBe(MSG.overLimit);
  expect(failure).not.toContain("未小于原片");
  expect(calls).toHaveLength(3);
});

it("does not save a quality result that is not smaller than the source", async () => {
  let failure = "";
  const calls = await runSized([5120], null, {
    onDone: () => { throw new Error("result that is not smaller was saved"); },
    onFail: (message) => { failure = message; },
    check: async (dir) => {
      expect(existsSync(join(dir, "input_720p.mp4"))).toBe(false);
      expect(existsSync(join(dir, "input_720p.mp4.partial"))).toBe(false);
      expect(existsSync(join(dir, "input_720p.mp4.x265pass.log.cutree"))).toBe(false);
    },
  });
  expect(failure).toBe(MSG.sizeNotSmaller);
  expect(failure).not.toContain("未能压到目标体积");
  expect(calls).toHaveLength(1);
});

it("does not save a constrained result that is not smaller than the source", async () => {
  let failure = "";
  const calls = await runSized([3072, 5120], 1, {
    onDone: () => { throw new Error("result that is not smaller was saved"); },
    onFail: (message) => { failure = message; },
    check: async (dir) => {
      expect(existsSync(join(dir, "input_720p.mp4"))).toBe(false);
    },
  });
  expect(failure).toBe(MSG.sizeNotSmaller);
  expect(failure).not.toContain("未能压到目标体积");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("-b:v");
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
