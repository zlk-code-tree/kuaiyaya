import { describe, expect, it } from "vitest";
import { progressMode, selectEncoder } from "../encoder";

describe("selectEncoder", () => {
  it("prefers VideoToolbox when available", () => {
    expect(selectEncoder({ videotoolbox: true, x265: true })).toBe("videotoolbox");
  });

  it("falls back to libx265 when VideoToolbox is missing", () => {
    expect(selectEncoder({ videotoolbox: false, x265: true })).toBe("x265");
  });

  it("falls back to libx265 after a VideoToolbox failure", () => {
    expect(selectEncoder({ videotoolbox: true, x265: true }, { lastFailed: "videotoolbox" })).toBe(
      "x265",
    );
  });

  it("returns null when nothing is left", () => {
    expect(selectEncoder({ videotoolbox: false, x265: false })).toBeNull();
    expect(selectEncoder({ videotoolbox: true, x265: false }, { lastFailed: "videotoolbox" })).toBeNull();
  });

  it("uses two-pass UI only for x265", () => {
    expect(progressMode("x265")).toBe("two-pass");
    expect(progressMode("videotoolbox")).toBe("single");
  });
});
