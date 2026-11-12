/** 纯字符串版，渲染进程也可调用（不依赖 node:path）。 */

import type { Size } from "./scale";

export function outputTag(size?: Size): string {
  if (!size) return "1080p";
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (long >= 1920 || short >= 1080) return "1080p";
  if (short >= 720 || long >= 1280) return "720p";
  return `${short}p`;
}

export function suggestedOutputName(inputPath: string, size?: Size): string {
  const file = inputPath.split(/[/\\]/).pop() ?? "video";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${base}_${outputTag(size)}.mp4`;
}
