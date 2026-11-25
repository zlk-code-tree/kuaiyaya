import type { EncoderKind } from "../shared/types";

const SAVED_BESIDE_SOURCE = "输出文件已保存在原片同一目录";
const SAVED_CHOSEN_DIR = "输出文件已保存到所选文件夹";
const QUALITY_REDUCED = "已压到目标上限以内。为达到这个体积，画质可能略低于按清晰度优先的结果。";
const TRIAL_PATH_DIFFERS = "输出文件已保存。实际编码参数与试压不同，请检查画质。";

export function doneSubtitle(input: {
  qualityReduced: boolean;
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
  customDirectory?: boolean;
}): string {
  const saved = input.customDirectory ? SAVED_CHOSEN_DIR : SAVED_BESIDE_SOURCE;
  if (input.qualityReduced) return `${saved}\n${QUALITY_REDUCED}`;
  if (trialPathDiffers(input)) return TRIAL_PATH_DIFFERS;
  return saved;
}

/**
 * 试压和没填时的正式压缩都走清晰度优先。
 * 只有这一轮用了试压，且正式清晰度优先的编码器与试压不一致时才提示。
 * 为了压进上限改走码率约束时，不叠这句。
 */
function trialPathDiffers(input: {
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
}): boolean {
  if (!input.usedAnalysis || input.analysisEncoder == null) return false;
  return input.encoder !== input.analysisEncoder;
}
