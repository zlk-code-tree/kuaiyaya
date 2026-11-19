/** 按目标体积反推视频码率。音频按 128 kbps AAC 预留，再留封装余量。 */

export const AUDIO_BITRATE_BPS = 128_000;
export const SAFETY_FACTOR = 0.94;
export const MIN_VIDEO_BITRATE_BPS = 80_000;
export const CONTAINER_OVERHEAD_BPS = 10_000;

export interface BitrateInput {
  targetBytes: number;
  durationSec: number;
  safetyFactor?: number;
  audioBitrateBps?: number;
  hasAudio?: boolean;
}

export function targetBytesFromMB(mb: number): number {
  return Math.max(1, Math.round(mb)) * 1024 * 1024;
}

export function videoBitrateBps(input: BitrateInput): number {
  const duration = Math.max(0.2, input.durationSec);
  const factor = input.safetyFactor ?? SAFETY_FACTOR;
  const audio = input.hasAudio === false ? 0 : (input.audioBitrateBps ?? AUDIO_BITRATE_BPS);
  const availableBits = input.targetBytes * 8 * factor;
  const raw = availableBits / duration - audio - CONTAINER_OVERHEAD_BPS;
  return Math.max(MIN_VIDEO_BITRATE_BPS, Math.floor(raw));
}

/** 第一次略超目标时，按超标比例再降一档码率，用于最多一次自动重试。 */
export function retryVideoBitrateBps(
  previousBps: number,
  outputBytes: number,
  targetBytes: number,
): number {
  if (outputBytes <= targetBytes || outputBytes <= 0) {
    return previousBps;
  }
  const scale = (targetBytes / outputBytes) * 0.92;
  return Math.max(MIN_VIDEO_BITRATE_BPS, Math.floor(previousBps * scale));
}

export function exceedsTarget(outputBytes: number, targetBytes: number): boolean {
  return outputBytes > targetBytes;
}

/** 旧的「原片一半」取整。不再作为开压目标，空输入不会调用它。 */
export function defaultTargetMB(sizeBytes: number): number {
  return Math.max(1, Math.round(sizeBytes / (1024 * 1024) / 2));
}

export function sliderBounds(sizeBytes: number): { min: number; max: number } {
  const origMB = sizeBytes / (1024 * 1024);
  const min = Math.max(8, Math.ceil(origMB * 0.05));
  const max = Math.max(min, Math.floor(origMB) - 1);
  return { min, max };
}

export function clampTargetMB(value: number, sizeBytes: number): number {
  const { min, max } = sliderBounds(sizeBytes);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function isTargetTooLarge(targetMB: number, sizeBytes: number): boolean {
  return targetMB * 1024 * 1024 >= sizeBytes;
}

/** 没填（targetMB 为 null）按原片体积预留；填了上限按 max(上限, 原片) 预留。 */
export function requiredDiskBytes(targetMB: number | null, sizeBytes?: number): number {
  const target = targetMB == null ? 0 : targetBytesFromMB(targetMB);
  const basis = sizeBytes != null ? Math.max(target, sizeBytes) : target;
  return basis + Math.max(200 * 1024 * 1024, Math.floor(basis * 0.2));
}
