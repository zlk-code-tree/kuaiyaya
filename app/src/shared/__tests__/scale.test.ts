import { describe, expect, it } from "vitest";
import { allocateOutputPath, suggestedOutputName } from "../output-name";
import { displaySize, even, fit1080, scaleFilter } from "../scale";

describe("scale", () => {
  it("does not upscale and keeps even dimensions", () => {
    expect(fit1080({ width: 1280, height: 720 })).toEqual({ width: 1080, height: 608 });
    expect(fit1080({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    const out = fit1080({ width: 3840, height: 2160 });
    expect(Math.max(out.width, out.height)).toBe(1080);
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
    expect(even(17)).toBe(16);
  });

  it("swaps sides for 90/270 rotation when computing display size", () => {
    expect(displaySize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    const fitted = fit1080(displaySize(1920, 1080, 90));
    expect(fitted.width).toBe(608); // 1080 * 1080/1920 even
    expect(fitted.height).toBe(1080);
  });

  it("emits a scale filter for oversized sources", () => {
    expect(scaleFilter({ width: 800, height: 600 })).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    expect(scaleFilter({ width: 3840, height: 2160 })).toMatch(/^scale=\d+:\d+$/);
  });
});

describe("output naming", () => {
  it("uses 原名_1080p.mp4 and increments without overwriting", () => {
    expect(suggestedOutputName("/tmp/假期.mov")).toBe("假期_1080p.mp4");
    const exists = (p: string) => p.endsWith("假期_1080p.mp4") || p.endsWith("假期_1080p (2).mp4");
    expect(allocateOutputPath("/tmp/假期.mov", exists)).toBe("/tmp/假期_1080p (3).mp4");
  });
});
