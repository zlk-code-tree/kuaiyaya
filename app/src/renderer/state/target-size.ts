import { isTargetTooLarge } from "../../shared/bitrate";
import { readSharedTarget } from "../../shared/queue";

/** 点一下填进「压到多大」。不是方案库，也没有「原片一半」。 */
export const SIZE_PRESETS_MB = [10, 25] as const;

export interface TargetState {
  sizeBytes: number;
  /** null：没填，按清晰度优先。 */
  targetMB: number | null;
  invalid: boolean;
  min: number;
  max: number;
}

function sliderEnds(sizeBytes: number): { min: number; max: number } {
  const max = Math.max(1, Math.floor(sizeBytes / (1024 * 1024)) - 1);
  return { min: 1, max };
}

/** 准备页默认空着。carriedMB 是从队列删回到一支时带回的已填上限。 */
export function fromFileSize(sizeBytes: number, carriedMB: number | null = null): TargetState {
  const { min, max } = sliderEnds(sizeBytes);
  const carried = carriedMB != null && Number.isFinite(carriedMB) ? Math.round(carriedMB) : null;
  return {
    sizeBytes,
    targetMB: carried != null && carried >= 1 ? carried : null,
    invalid: false,
    min,
    max,
  };
}

export function applyTyped(state: TargetState, raw: string): TargetState {
  const read = readSharedTarget(raw);
  if (read.kind === "quality") return { ...state, targetMB: null, invalid: false };
  if (read.kind === "invalid") return { ...state, targetMB: null, invalid: true };
  return { ...state, targetMB: read.mb, invalid: false };
}

/** 空着或非法时没有滑块位置。不要用最小值 1 冒充已填写。 */
export function sliderThumbMB(state: TargetState): number | null {
  if (state.invalid || state.targetMB == null) return null;
  const max = Math.max(state.min, state.max);
  return Math.min(max, Math.max(state.min, state.targetMB));
}

/** 只有用户拖动滑条时才写入数字，空态不会自己填。 */
export function applySlider(state: TargetState, raw: number): TargetState {
  if (!Number.isFinite(raw)) return state;
  const value = Math.min(state.max, Math.max(state.min, Math.round(raw)));
  return { ...state, targetMB: value, invalid: false };
}

export function tooLarge(state: TargetState): boolean {
  return state.targetMB != null && isTargetTooLarge(state.targetMB, state.sizeBytes);
}
