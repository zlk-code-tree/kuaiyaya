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

const base = {
  ffmpegPath: "ffmpeg",
  input: probe.path,
  output: "/tmp/a_1080p.mp4.partial",
  probe,
  targetBytes: 10 * 1024 * 1024,
};

describe("ffmpeg command plans", () => {
  it("defaults to one quality pass for libx265: crf 20, preset fast, no bitrate pass", () => {
    const plan = buildCommands({ ...base, encoder: "x265" });
    expect(plan.args).toHaveLength(1);
    const line = plan.args[0].join(" ");
    expect(line).toContain("-c:v libx265");
    expect(line).toContain("-crf 20");
    expect(line).toContain("-preset fast");
    expect(line).not.toContain("-pass ");
    expect(line).not.toContain("-passlogfile");
    expect(line).not.toContain("-b:v");
    expect(line).not.toContain("-maxrate");
    expect(line).not.toContain("-bufsize");
    expect(line).toContain("-map 0:v:0");
    expect(line).toContain("-map 0:a:0?");
    expect(line).toContain("-c:a aac");
    expect(line).toContain("-b:a 128k");
    expect(line).toContain("-tag:v hvc1");
    expect(line).toContain("-movflags +faststart");
    expect(line).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(line).not.toContain("scale=1920:1080");
  });

  it("treats an explicit quality mode the same as the default", () => {
    const implicit = buildCommands({ ...base, encoder: "x265" });
    const explicit = buildCommands({ ...base, encoder: "x265", mode: "quality" });
    expect(explicit.args).toEqual(implicit.args);
  });

  it("uses one VideoToolbox quality pass at -q:v 70 and does not downscale 1080p", () => {
    const plan = buildCommands({ ...base, encoder: "videotoolbox" });
    expect(plan.args).toHaveLength(1);
    const line = plan.args[0].join(" ");
    expect(plan.args[0]).toContain("hevc_videotoolbox");
    expect(line).toContain("-q:v 70");
    expect(line).not.toContain("-b:v");
    expect(line).not.toContain("-maxrate");
    expect(line).not.toContain("-bufsize");
    expect(line).not.toContain("-pass ");
    expect(line).toContain("-allow_sw 0");
    expect(line).toContain("-prio_speed 0");
    expect(line).toContain("-spatial_aq 1");
    expect(line).toContain("-tag:v hvc1");
    expect(line).toContain("-movflags +faststart");
    expect(line).toContain("-c:a aac");
    expect(line).toContain("-b:a 128k");
    expect(line).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(line).not.toContain("scale=1920:1080");
  });

  it("scales 4K down to a 1920 long edge", () => {
    const uhd = { ...probe, width: 3840, height: 2160, displayWidth: 3840, displayHeight: 2160 };
    const plan = buildCommands({
      ...base,
      encoder: "videotoolbox",
      probe: uhd,
      input: uhd.path,
    });
    expect(plan.args[0].join(" ")).toContain("scale=1920:1080");
  });

  it("keeps two-pass ABR, widened VBV, and the fast second pass for bitrate mode", () => {
    const plan = buildCommands({ ...base, encoder: "x265", mode: "bitrate" });
    expect(plan.args).toHaveLength(2);
    const pass1 = plan.args[0].join(" ");
    const pass2 = plan.args[1].join(" ");
    expect(pass1).toContain(`-b:v ${plan.videoBitrateBps}`);
    expect(pass1).toContain(`-maxrate ${Math.floor(plan.videoBitrateBps * 1.5)}`);
    expect(pass1).toContain(`-bufsize ${plan.videoBitrateBps * 3}`);
    expect(pass1).toContain("-preset veryfast");
    expect(pass1).toContain("-pass 1");
    expect(pass1).toContain("-passlogfile");
    expect(pass1).not.toContain("-crf");
    expect(pass2).toContain("-pass 2");
    expect(pass2).toContain("-preset fast");
    expect(pass2).not.toContain("-preset veryfast");
    expect(pass2).toContain(`-b:v ${plan.videoBitrateBps}`);
    expect(pass2).toContain(`-maxrate ${Math.floor(plan.videoBitrateBps * 1.5)}`);
    expect(pass2).toContain(`-bufsize ${plan.videoBitrateBps * 3}`);
    expect(plan.args[0]).toContainEqual("libx265");
    expect(pass1).toContain("-map 0:v:0");
    expect(pass2).toContain("-map 0:v:0");
    expect(pass2).toContain("-map 0:a:0?");
    expect(pass2).toContain("-tag:v hvc1");
    expect(pass2).toContain("-movflags +faststart");
    expect(pass2).toContain("-c:a aac");
    expect(pass2).toContain("-b:a 128k");
    expect(pass1).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(plan.args[0][plan.args[0].length - 1]).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(plan.args[1][plan.args[1].length - 1]).toBe(base.output);

    const windows = buildCommands({ ...base, encoder: "x265", mode: "bitrate", nullSink: "NUL" });
    expect(windows.args[0][windows.args[0].length - 1]).toBe("NUL");
    expect(windows.args[1][windows.args[1].length - 1]).toBe(base.output);
  });

  it("keeps an explicit bitrate override on the two-pass libx265 path", () => {
    const plan = buildCommands({ ...base, encoder: "x265", mode: "bitrate", videoBps: 1_000_000 });
    expect(plan.args).toHaveLength(2);
    expect(plan.videoBitrateBps).toBe(1_000_000);
    expect(plan.args[0].join(" ")).toContain("-pass 1");
    expect(plan.args[0].join(" ")).toContain("-preset veryfast");
    expect(plan.args[1].join(" ")).toContain("-pass 2");
    expect(plan.args[1].join(" ")).toContain("-preset fast");
    expect(plan.args[1].join(" ")).toContain("-b:v 1000000");
    expect(plan.args[1].join(" ")).toContain(`-maxrate ${Math.floor(1_000_000 * 1.5)}`);
    expect(plan.args[1].join(" ")).toContain(`-bufsize ${1_000_000 * 3}`);
  });

  it("keeps tightened VideoToolbox VBV and the hardware quality flags in bitrate mode", () => {
    const plan = buildCommands({ ...base, encoder: "videotoolbox", mode: "bitrate" });
    expect(plan.args).toHaveLength(1);
    const line = plan.args[0].join(" ");
    expect(plan.args[0]).toContain("hevc_videotoolbox");
    expect(line).toContain(`-b:v ${plan.videoBitrateBps}`);
    expect(line).toContain(`-maxrate ${Math.floor(plan.videoBitrateBps * 1.1)}`);
    expect(line).toContain(`-bufsize ${Math.floor(plan.videoBitrateBps * 2)}`);
    expect(line).toContain("-allow_sw 0");
    expect(line).toContain("-prio_speed 0");
    expect(line).toContain("-spatial_aq 1");
    expect(line).not.toContain("-q:v ");
    expect(line).not.toContain("-pass ");
    expect(line).toContain("-tag:v hvc1");
    expect(line).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });
});
