import { describe, expect, it } from "vitest";
import { allocateOutputPath, suggestedOutputName } from "../output-name";
import { displaySize, even, fitOutput, scaleFilter } from "../scale";

describe("scale", () => {
  it("keeps 1080p and below, and does not upscale", () => {
    expect(fitOutput({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(fitOutput({ width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(fitOutput({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(even(17)).toBe(16);
  });

  it("scales 4K down to true 1920×1080", () => {
    const out = fitOutput({ width: 3840, height: 2160 });
    expect(out).toEqual({ width: 1920, height: 1080 });
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
  });

  it("keeps a rotated 1080p video at 1080×1920", () => {
    expect(displaySize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    const fitted = fitOutput(displaySize(1920, 1080, 90));
    expect(fitted).toEqual({ width: 1080, height: 1920 });
  });

  it("emits a scale filter only for oversized sources", () => {
    expect(scaleFilter({ width: 800, height: 600 })).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(scaleFilter({ width: 1920, height: 1080 })).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(scaleFilter({ width: 3840, height: 2160 })).toBe("scale=1920:1080");
  });
});

describe("output naming", () => {
  it("uses 原名_1080p.mp4 for 1080p output and increments without overwriting", () => {
    const size = { width: 1920, height: 1080 };
    expect(suggestedOutputName("/tmp/假期.mov", size)).toBe("假期_1080p.mp4");
    const exists = (p: string) => p.endsWith("假期_1080p.mp4") || p.endsWith("假期_1080p (2).mp4");
    expect(allocateOutputPath("/tmp/假期.mov", exists, size)).toBe("/tmp/假期_1080p (3).mp4");
  });

  it("names 720p output as _720p", () => {
    expect(suggestedOutputName("/tmp/假期.mov", { width: 1280, height: 720 })).toBe("假期_720p.mp4");
  });

  it("keeps the resolution name until a pattern or folder is set, then uses that and still refuses to overwrite", () => {
    const small = { width: 1280, height: 720 };
    const held = new Set<string>();
    const nowhere = () => false;
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small)).toBe("/videos/假期_720p.mp4");
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small, { directory: "/out", pattern: null }, held)).toBe("/out/假期_720p.mp4");
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small, { directory: "/out", pattern: "{originalStem}_1080p.mp4" })).toBe("/out/假期_1080p.mp4");
    const taken = (p: string) => p === "/out/假期_mail.mp4";
    expect(allocateOutputPath("/videos/假期.mov", taken, small, { directory: "/out", pattern: "{originalStem}_mail" })).toBe("/out/假期_mail (2).mp4");
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small, { directory: "/out", pattern: "{originalStem}_mail.mp4" }, held)).toBe("/out/假期_mail.mp4");
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small, { directory: "/out", pattern: "{originalStem}_mail.mp4" }, held)).toBe("/out/假期_mail (2).mp4");
    held.delete("/out/假期_mail.mp4");
    expect(allocateOutputPath("/videos/假期.mov", nowhere, small, { directory: "/out", pattern: "{originalStem}_mail.mp4" }, held)).toBe("/out/假期_mail.mp4");
  });
});
