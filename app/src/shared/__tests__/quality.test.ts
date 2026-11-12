import { describe, expect, it } from "vitest";
import { candidateTargets, estimateSizeMB, lowBitrateBudget, passesQualityHeuristic, preferSoftware, recommendCandidate, sampleRanges } from "../quality";
import type { QualityCandidate } from "../types";

const mib = 1024 * 1024;

describe("quality analysis planning", () => {
  it("samples distinct parts of a long video without seeking past the end", () => {
    const ranges = sampleRanges(100);
    expect(ranges).toHaveLength(3);
    expect(ranges.map((range) => Math.round(range.startSec))).toEqual([14, 49, 84]);
    expect(ranges.every((range) => range.startSec >= 0 && range.startSec + range.durationSec <= 100)).toBe(true);
    expect(sampleRanges(2)).toEqual([{ startSec: 0, durationSec: 2 }]);
    expect(sampleRanges(0)).toEqual([]);
  });

  it("compares the chosen target to a larger candidate below the original", () => {
    expect(candidateTargets(245, 1342 * mib)).toEqual([245, 671]);
    expect(candidateTargets(100, 101 * mib)).toEqual([100]);
    expect(candidateTargets(80, 100.5 * mib)).toEqual([80, 99]);
    expect(candidateTargets(101, 101 * mib)).toEqual([]);
    expect(candidateTargets(NaN, 100 * mib)).toEqual([]);
  });

  it("includes the intended audio bitrate when estimating full-video size", () => {
    const withoutAudio = estimateSizeMB(mib, 10, 100, false);
    const withAudio = estimateSizeMB(mib, 10, 100, true);
    expect(withAudio - withoutAudio).toBeCloseTo(128_000 / 8 * 100 / mib);
    expect(lowBitrateBudget(1, 3600, true)).toBe(true);
    expect(lowBitrateBudget(500, 3600, true)).toBe(false);
  });

  it("recommends the first passing candidate or the larger candidate with a risk warning", () => {
    const candidates: QualityCandidate[] = [
      { targetMB: 200, estimatedMB: 180, lowestScore: 0.96, averageScore: 0.97 },
      { targetMB: 500, estimatedMB: 480, lowestScore: 0.985, averageScore: 0.99 },
    ];
    expect(recommendCandidate("ssim", candidates).targetMB).toBe(500);
    expect(passesQualityHeuristic("ssim", 0.96)).toBe(false);
    expect(passesQualityHeuristic("vmaf", 90)).toBe(true);
    expect(recommendCandidate("vmaf", candidates.map((value) => ({ ...value, lowestScore: 80 }))).targetMB).toBe(500);
    expect(recommendCandidate("vmaf", candidates.map((value) => ({ ...value, lowestScore: 95 }))).targetMB).toBe(200);
    expect(recommendCandidate("vmaf", candidates.map((value, i) => ({ ...value, lowestScore: 95, lowBitrateBudget: i === 0 }))).targetMB).toBe(500);
  });

  it("switches to software only when samples show a meaningful benefit", () => {
    const hardware: QualityCandidate[] = [
      { targetMB: 200, estimatedMB: 190, lowestScore: 80, averageScore: 85 },
      { targetMB: 500, estimatedMB: 480, lowestScore: 87, averageScore: 90 },
    ];
    const better = hardware.map((candidate) => ({ ...candidate, lowestScore: candidate.lowestScore + 3 }));
    const similar = hardware.map((candidate) => ({ ...candidate, lowestScore: candidate.lowestScore + 0.5 }));
    expect(preferSoftware("vmaf", hardware, better)).toBe(true);
    expect(preferSoftware("vmaf", hardware, similar)).toBe(false);
  });
});
