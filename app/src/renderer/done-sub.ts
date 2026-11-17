import type { EncoderKind } from "../shared/types";

const SAVED_BESIDE_SOURCE = "输出文件已保存在原片同一目录";
const EXCEEDED_REFERENCE = "实际体积超出了参考目标。";
const TRIAL_PATH_DIFFERS = "输出文件已保存。实际编码参数与试压不同，请检查画质。";

export function doneSubtitle(input: {
  exceededTarget: boolean;
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
}): string {
  const notes: string[] = [];
  if (input.exceededTarget) notes.push(EXCEEDED_REFERENCE);
  if (trialPathDiffers(input)) notes.push(TRIAL_PATH_DIFFERS);
  return notes.length > 0 ? notes.join("\n") : SAVED_BESIDE_SOURCE;
}

/**
 * 试压按目标码率取样，正式压缩按清晰度优先。
 * 编码器种类相同也不代表两条路径相同。
 */
function trialPathDiffers(input: {
  usedAnalysis: boolean;
  encoder: EncoderKind;
  analysisEncoder: EncoderKind | null;
}): boolean {
  if (!input.usedAnalysis || input.analysisEncoder == null) return false;
  switch (input.encoder) {
    case "videotoolbox":
    case "x265":
      return true;
    default: {
      const unreachable: never = input.encoder;
      return unreachable;
    }
  }
}
