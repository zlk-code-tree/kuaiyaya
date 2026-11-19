import { isTargetTooLarge, sliderBounds } from "../../shared/bitrate";

export interface TargetState {
  sizeBytes: number;
  /** null 表示没填，走清晰度优先。 */
  targetMB: number | null;
  /** 填了内容，但不是 1 以上的整数。 */
  invalid: boolean;
  min: number;
  max: number;
}

export function emptyTarget(sizeBytes: number): TargetState {
  const { min, max } = sliderBounds(sizeBytes);
  return { sizeBytes, targetMB: null, invalid: false, min, max };
}

export function clearTarget(state: TargetState): TargetState {
  return { ...state, targetMB: null, invalid: false };
}

/** 用户输入或拖动滑条后的上限。空着和非法数字不会被收成一半。 */
export function applyInput(state: TargetState, raw: number): TargetState {
  if (!Number.isFinite(raw)) return { ...state, targetMB: null, invalid: true };
  const mb = Math.round(raw);
  if (mb < 1) return { ...state, targetMB: null, invalid: true };
  return { ...state, targetMB: mb, invalid: false };
}

/** 用户点「用作上限」后，把试压估计原样写入，不偷偷改成别的档。 */
export function applyCeiling(state: TargetState, estimatedMB: number): TargetState {
  const mb = Math.round(estimatedMB);
  if (!Number.isFinite(mb) || mb < 1) return state;
  return { ...state, targetMB: mb, invalid: false };
}

/** 试压结果默认不回填。只有用户明确点选才进入上限模式。 */
export function targetAfterAnalysis(state: TargetState, estimatedMB: number, useAsLimit: boolean): TargetState {
  if (!useAsLimit) return state;
  return applyCeiling(state, estimatedMB);
}

export function tooLarge(state: TargetState): boolean {
  if (state.targetMB == null || state.invalid) return false;
  return isTargetTooLarge(state.targetMB, state.sizeBytes);
}

export function blocksStart(state: TargetState): boolean {
  return state.invalid || tooLarge(state);
}
