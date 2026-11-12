import { describe, expect, it } from "vitest";
import {
  AUDIO_BITRATE_BPS,
  clampTargetMB,
  defaultTargetMB,
  exceedsTarget,
  isTargetTooLarge,
  requiredDiskBytes,
  retryVideoBitrateBps,
  sliderBounds,
  targetBytesFromMB,
  videoBitrateBps,
} from "../bitrate";

describe("target size defaults", () => {
  it("rounds half of the original size to an integer MB", () => {
    expect(defaultTargetMB(100 * 1024 * 1024)).toBe(50);
    expect(defaultTargetMB(21 * 1024 * 1024)).toBe(11);
  });

  it("does not allow a target >= original size", () => {
    const size = 40 * 1024 * 1024;
    expect(isTargetTooLarge(40, size)).toBe(true);
    expect(isTargetTooLarge(39, size)).toBe(false);
    const { max } = sliderBounds(size);
    expect(max).toBe(39);
    expect(clampTargetMB(999, size)).toBe(39);
  });

  it("uses min = max(8, 5% of original MB)", () => {
    expect(sliderBounds(200 * 1024 * 1024).min).toBe(10);
    expect(sliderBounds(100 * 1024 * 1024).min).toBe(8);
  });
});

describe("videoBitrateBps", () => {
  it("subtracts 128kbps AAC and keeps a safety margin", () => {
    const target = targetBytesFromMB(10);
    const bps = videoBitrateBps({ targetBytes: target, durationSec: 60, hasAudio: true });
    const available = (target * 8 * 0.94) / 60;
    expect(bps).toBe(Math.max(80_000, Math.floor(available - AUDIO_BITRATE_BPS - 10_000)));
    expect(bps).toBeLessThan(available);
  });

  it("skips audio reservation when there is no audio track", () => {
    const withAudio = videoBitrateBps({ targetBytes: 5_000_000, durationSec: 20, hasAudio: true });
    const noAudio = videoBitrateBps({ targetBytes: 5_000_000, durationSec: 20, hasAudio: false });
    expect(noAudio).toBeGreaterThan(withAudio);
  });

  it("never goes below the minimum video bitrate", () => {
    const bps = videoBitrateBps({ targetBytes: 1000, durationSec: 3600, hasAudio: true });
    expect(bps).toBe(80_000);
  });
});

describe("retry and exceeds", () => {
  it("treats any byte over the target as exceeding (不得超过)", () => {
    expect(exceedsTarget(10, 10)).toBe(false);
    expect(exceedsTarget(11, 10)).toBe(true);
  });

  it("lowers bitrate proportionally for a single retry", () => {
    const next = retryVideoBitrateBps(1_000_000, 12_000_000, 10_000_000);
    expect(next).toBe(Math.floor(1_000_000 * (10 / 12) * 0.92));
    expect(next).toBeLessThan(1_000_000);
  });
});

describe("disk reserve", () => {
  it("requires basis + max(200MB, 20% of basis), using the larger of target and original size", () => {
    expect(requiredDiskBytes(100)).toBe((100 + 200) * 1024 * 1024);
    expect(requiredDiskBytes(2000)).toBe((2000 + 400) * 1024 * 1024);
    expect(requiredDiskBytes(100, 800 * 1024 * 1024)).toBe((800 + 200) * 1024 * 1024);
  });
});
