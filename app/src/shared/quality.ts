import type { QualityCandidate, QualityMetric } from "./types";
import { AUDIO_BITRATE_BPS, CONTAINER_OVERHEAD_BPS, MIN_VIDEO_BITRATE_BPS, SAFETY_FACTOR, sliderBounds } from "./bitrate";

const MIB = 1024 * 1024;

export interface SampleRange {
  startSec: number;
  durationSec: number;
}

/** 均匀选取短片段；短视频避免重复取同一个片段。 */
export function sampleRanges(durationSec: number): SampleRange[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (durationSec < 6) return [{ startSec: 0, durationSec: Math.min(3, durationSec) }];
  const length = Math.min(3, durationSec / 3);
  return [0.15, 0.5, 0.85].map((fraction) => ({
    startSec: Math.max(0, Math.min(durationSec - length, durationSec * fraction - length / 2)),
    durationSec: length,
  }));
}

/** 在原目标之外，试一个更注重画质、但仍小于原片的目标。 */
export function candidateTargets(targetMB: number, originalBytes: number): number[] {
  const max = Math.min(Math.floor((originalBytes - 1) / MIB), sliderBounds(originalBytes).max);
  if (!Number.isInteger(targetMB) || targetMB <= 0 || targetMB > max) return [];
  const larger = Math.min(max, Math.max(targetMB + 1, Math.ceil(targetMB * 1.6), Math.ceil(originalBytes / MIB / 2)));
  return larger > targetMB ? [targetMB, larger] : [targetMB];
}

/** 样片外推体积收成整数 MB，供展示和「用作上限」。不回填到输入框。 */
export function roundEstimateMB(estimatedMB: number): number {
  if (!Number.isFinite(estimatedMB) || estimatedMB <= 0) return 1;
  return Math.max(1, Math.round(estimatedMB));
}

/** 基于抽样视频体积外推，音频按最终编码的 128 kbps 估算。 */
export function estimateSizeMB(
  sampleBytes: number,
  sampledSeconds: number,
  durationSec: number,
  hasAudio: boolean,
): number {
  const bytesPerSec = sampleBytes / sampledSeconds + ((hasAudio ? AUDIO_BITRATE_BPS : 0) + CONTAINER_OVERHEAD_BPS) / 8;
  return Math.max(0, bytesPerSec * durationSec / MIB);
}

export function passesQualityHeuristic(metric: QualityMetric, score: number): boolean {
  return score >= (metric === "vmaf" ? 90 : 0.97);
}

export function lowBitrateBudget(targetMB: number, durationSec: number, hasAudio: boolean): boolean {
  const availableBps = targetMB * MIB * 8 * SAFETY_FACTOR / Math.max(0.2, durationSec);
  return availableBps < MIN_VIDEO_BITRATE_BPS + CONTAINER_OVERHEAD_BPS + (hasAudio ? AUDIO_BITRATE_BPS : 0);
}

/** 阈值仅用于排序提示，不是对实际视觉质量的保证。 */
export function recommendCandidate(metric: QualityMetric, candidates: QualityCandidate[]): QualityCandidate {
  if (candidates.length === 0) throw new Error("没有可用的试压结果");
  return candidates.find((candidate) => !candidate.lowBitrateBudget && passesQualityHeuristic(metric, candidate.lowestScore)) ?? candidates[candidates.length - 1];
}

/** 画质更好时切换软编码；差异很小时保留更快的硬编码。 */
export function preferSoftware(
  metric: QualityMetric,
  hardware: QualityCandidate[],
  software: QualityCandidate[],
): boolean {
  const fast = recommendCandidate(metric, hardware);
  const detailed = recommendCandidate(metric, software);
  if (detailed.targetMB !== fast.targetMB) return detailed.targetMB < fast.targetMB;
  const margin = metric === "vmaf" ? 1 : 0.003;
  return detailed.lowestScore - fast.lowestScore >= margin;
}
