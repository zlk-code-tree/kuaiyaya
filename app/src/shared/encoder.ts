import type { EncoderCaps, EncoderKind } from "./types";

/**
 * 第一期默认走最快路径：探测到 VideoToolbox HEVC 就用硬编，
 * 没有或失败则回退 libx265。界面不提供编码器选择。
 */
export function selectEncoder(
  caps: Pick<EncoderCaps, "videotoolbox" | "x265">,
  opts?: { lastFailed?: EncoderKind },
): EncoderKind | null {
  if (opts?.lastFailed === "videotoolbox") {
    return caps.x265 ? "x265" : null;
  }
  if (caps.videotoolbox) return "videotoolbox";
  if (caps.x265) return "x265";
  return null;
}

export function progressMode(kind: EncoderKind): "two-pass" | "single" {
  return kind === "x265" ? "two-pass" : "single";
}
