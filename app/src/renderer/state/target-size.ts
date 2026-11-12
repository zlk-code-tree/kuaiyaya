import { clampTargetMB, defaultTargetMB, isTargetTooLarge, sliderBounds } from "../../shared/bitrate";

export interface TargetState {
  sizeBytes: number;
  targetMB: number;
  min: number;
  max: number;
}

export function fromFileSize(sizeBytes: number): TargetState {
  const { min, max } = sliderBounds(sizeBytes);
  let target = defaultTargetMB(sizeBytes);
  if (target >= Math.floor(sizeBytes / (1024 * 1024))) {
    target = Math.max(min, max);
  }
  return { sizeBytes, targetMB: clampTargetMB(target, sizeBytes), min, max };
}

export function applyInput(state: TargetState, raw: number): TargetState {
  return { ...state, targetMB: clampTargetMB(raw, state.sizeBytes) };
}

export function tooLarge(state: TargetState): boolean {
  return isTargetTooLarge(state.targetMB, state.sizeBytes);
}
