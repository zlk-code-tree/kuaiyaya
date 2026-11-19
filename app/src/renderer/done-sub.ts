import type { EncoderKind } from "../shared/types";

const SAVED_BESIDE_SOURCE = "输出文件已保存在原片同一目录";
const QUALITY_REDUCED = "已压到目标上限以内。为达到这个体积，画质可能略低于按清晰度优先的结果。";
const TRIAL_PATH_DIFFERS = "输出文件已保存。实际编码参数与试压不同，请检查画质。";

export function doneSubtitle(input: {
  qualityReduced: boolean;
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
}): string {
  if (input.qualityReduced) return `${SAVED_BESIDE_SOURCE}\n${QUALITY_REDUCED}`;
  if (trialPathDiffers(input)) return TRIAL_PATH_DIFFERS;
  return SAVED_BESIDE_SOURCE;
}

/**
 * 试压和没填时的正式压缩都走清晰度优先。
 * 只有编码器种类不一致时才提示路径不同。
 * 为了压进上限而改走码率约束时，不叠这句。
 */
function trialPathDiffers(input: {
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
}): boolean {
  if (!input.usedAnalysis || input.analysisEncoder == null) return false;
  return input.encoder !== input.analysisEncoder;
}
