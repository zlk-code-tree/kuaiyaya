import { describe, expect, it } from "vitest";
import type { ProbeInfo } from "../../../shared/types";
import { buildCommands } from "../bitrate-cmd";

const probe: ProbeInfo = {
  path: "/tmp/a.mov",
  name: "a.mov",
  sizeBytes: 20 * 1024 * 1024,
  durationSec: 30,
  width: 1920,
  height: 1080,
  rotation: 0,
  displayWidth: 1920,
  displayHeight: 1080,
  videoCodec: "h264",
  hasAudio: true,
  container: "mov",
};

describe("ffmpeg command plans", () => {
  it("uses target bitrate with two-pass libx265, hvc1 and faststart", () => {
    const plan = buildCommands({
      encoder: "x265",
      ffmpegPath: "ffmpeg",
      input: probe.path,
      output: "/tmp/a_1080p.mp4.partial",
      probe,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(plan.args).toHaveLength(2);
    expect(plan.args[0].join(" ")).toContain(`-b:v ${plan.videoBitrateBps}`);
    expect(plan.args[0].join(" ")).toContain("-pass 1");
    expect(plan.args[1].join(" ")).toContain("-pass 2");
    expect(plan.args[0]).toContainEqual("libx265");
    expect(plan.args[0].join(" ")).toContain("-map 0:v:0");
    expect(plan.args[1].join(" ")).toContain("-map 0:v:0");
    expect(plan.args[1].join(" ")).toContain("-map 0:a:0?");
    expect(plan.args[1].join(" ")).toContain("-tag:v hvc1");
    expect(plan.args[1].join(" ")).toContain("-movflags +faststart");
    expect(plan.args[1].join(" ")).toContain("-c:a aac");
    expect(plan.args[1].join(" ")).toContain("-b:a 128k");
    expect(plan.args[0].join(" ")).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("falls back to two-pass libx265 bitrate when a size cap retry is requested", () => {
    const plan = buildCommands({
      encoder: "x265",
      ffmpegPath: "ffmpeg",
      input: probe.path,
      output: "/tmp/a_1080p.mp4.partial",
      probe,
      targetBytes: 10 * 1024 * 1024,
      videoBps: 1_000_000,
    });
    expect(plan.args).toHaveLength(2);
    expect(plan.args[0].join(" ")).toContain("-pass 1");
    expect(plan.args[1].join(" ")).toContain("-pass 2");
    expect(plan.args[1].join(" ")).toContain("-b:v 1000000");
  });

  it("uses target bitrate for hevc_videotoolbox, and does not downscale 1080p", () => {
    const plan = buildCommands({
      encoder: "videotoolbox",
      ffmpegPath: "ffmpeg",
      input: probe.path,
      output: "/tmp/a_1080p.mp4.partial",
      probe,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(plan.args).toHaveLength(1);
    expect(plan.args[0]).toContain("hevc_videotoolbox");
    expect(plan.args[0].join(" ")).toContain(`-b:v ${plan.videoBitrateBps}`);
    expect(plan.args[0].join(" ")).not.toContain("-q:v ");
    expect(plan.args[0].join(" ")).not.toContain("-pass ");
    expect(plan.args[0].join(" ")).toContain("-tag:v hvc1");
    expect(plan.args[0].join(" ")).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("scales 4K down to 1920×1080", () => {
    const uhd = { ...probe, width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160 };
    const plan = buildCommands({
      encoder: "videotoolbox",
      ffmpegPath: "ffmpeg",
      input: uhd.path,
      output: "/tmp/a_1080p.mp4.partial",
      probe: uhd,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(plan.args[0].join(" ")).toContain("scale=1920:1080");
  });
});
