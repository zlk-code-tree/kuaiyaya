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
  it("uses two-pass libx265 with hvc1 and faststart", () => {
    const plan = buildCommands({
      encoder: "x265",
      ffmpegPath: "ffmpeg",
      input: probe.path,
      output: "/tmp/a_1080p.mp4.partial",
      probe,
      targetBytes: 10 * 1024 * 1024,
    });
    expect(plan.args).toHaveLength(2);
    expect(plan.args[0].join(" ")).toContain("-pass 1");
    expect(plan.args[0].join(" ")).toContain("-an");
    expect(plan.args[1].join(" ")).toContain("-pass 2");
    expect(plan.args[1]).toContainEqual("libx265");
    expect(plan.args[1].join(" ")).toContain("-tag:v hvc1");
    expect(plan.args[1].join(" ")).toContain("-movflags +faststart");
    expect(plan.args[1].join(" ")).toContain("-c:a aac");
    expect(plan.args[1].join(" ")).toContain("-b:a 128k");
  });

  it("uses a single hevc_videotoolbox segment", () => {
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
    expect(plan.args[0].join(" ")).not.toContain("-pass ");
    expect(plan.args[0].join(" ")).toContain("-tag:v hvc1");
  });
});
