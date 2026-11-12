import { basename, dirname, extname, join } from "node:path";
import { suggestedOutputName, outputTag } from "./filename";
import type { Size } from "./scale";

export { suggestedOutputName, outputTag };

export function allocateOutputPath(inputPath: string, exists: (p: string) => boolean, size?: Size): string {
  const dir = dirname(inputPath);
  const first = join(dir, suggestedOutputName(inputPath, size));
  if (!exists(first)) return first;
  const stem = basename(inputPath, extname(inputPath));
  const tag = outputTag(size);
  for (let i = 2; i < 1000; i++) {
    const candidate = join(dir, `${stem}_${tag} (${i}).mp4`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error("无法分配不冲突的输出文件名");
}

export function partialPath(finalPath: string): string {
  return `${finalPath}.partial`;
}

export function passLogPrefix(finalPath: string): string {
  return `${finalPath}.x265pass`;
}
