import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProbeInfo } from "../../../shared/types";

const calls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("../bitrate-cmd", () => ({
  buildCommands: (opts: Record<string, unknown>) => {
    calls.push(opts);
    return {
      encoder: opts.encoder,
      videoBitrateBps: 800_000,
      args: [["-y", String(opts.output)]],
      passLog: opts.passLog,
    };
  },
}));

vi.mock("../probe", () => ({
  probeFile: async (_ffprobe: string, path: string): Promise<ProbeInfo> => ({
    path,
    name: "reference.mkv",
    sizeBytes: 1000,
    durationSec: 1,
    width: 640,
    height: 360,
    rotation: 0,
    displayWidth: 640,
    displayHeight: 360,
    videoCodec: "ffv1",
    hasAudio: false,
    container: "mkv",
  }),
}));

import { QualityAnalyzer } from "../quality-analysis";

const caps = {
  x265: true,
  videotoolbox: false,
  ffmpegVersion: "test",
  probedAt: "",
  ffmpegPath: "ffmpeg",
};

beforeEach(() => {
  calls.length = 0;
});

it("encodes the sample with the quality pass and does not fill a limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-mode-"));
  try {
    const input = join(dir, "input.mp4");
    const ffmpeg = join(dir, "fake-ffmpeg");
    await writeFile(input, Buffer.alloc(20 * 1024 * 1024, 1));
    await writeFile(
      ffmpeg,
      `#!/bin/sh
for arg do
  if [ "$arg" = "-filters" ]; then
    printf ' T. ssim\\n'
    exit 0
  fi
done
for arg do
  case "$arg" in
    *ssim*)
      printf 'SSIM All: 0.99\\n'
      exit 0
      ;;
  esac
done
last=""
for arg do last=$arg; done
case "$last" in
  -*) exit 0 ;;
esac
printf 'x' > "$last"
exit 0
`,
    );
    await chmod(ffmpeg, 0o755);
    const source = await stat(input);
    const probe: ProbeInfo = {
      path: input,
      name: "input.mp4",
      sizeBytes: source.size,
      durationSec: 3,
      width: 1280,
      height: 720,
      rotation: 0,
      displayWidth: 1280,
      displayHeight: 720,
      videoCodec: "h264",
      hasAudio: false,
      container: "mp4",
    };

    const result = await new QualityAnalyzer().run({
      ffmpeg,
      ffprobe: "ffprobe",
      probe,
      targetMB: null,
      caps,
      onProgress: () => undefined,
    });

    expect(result.encoder).toBe("x265");
    expect(result.estimatedMB).toBeGreaterThanOrEqual(1);
    expect(result.withinLimit).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.mode === "quality")).toBe(true);
    expect(calls.every((call) => call.mode !== "bitrate" && call.encoder === "x265")).toBe(true);
    expect((await stat(input)).size).toBe(probe.sizeBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
