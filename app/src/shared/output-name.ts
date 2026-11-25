import { basename, dirname, join } from "node:path";
import { plannedOutputName, suffixedFileName, suggestedOutputName, outputTag } from "./filename";
import type { Size } from "./scale";
import type { OutputPlan } from "./types";

export { suggestedOutputName, outputTag };

export function allocateOutputPath(
  inputPath: string,
  exists: (p: string) => boolean,
  size?: Size,
  output?: Pick<OutputPlan, "directory" | "pattern"> | null,
  held?: Set<string>,
): string {
  const dir = output?.directory?.trim() ? output.directory.trim() : dirname(inputPath);
  const fileName = plannedOutputName(inputPath, size, output?.pattern);
  for (let i = 1; i < 1000; i++) {
    const name = suffixedFileName(fileName, i);
    const candidate = join(dir, name);
    if (basename(candidate) !== name) break;
    if (exists(candidate) || held?.has(candidate)) continue;
    held?.add(candidate);
    return candidate;
  }
  throw new Error("无法分配不冲突的输出文件名");
}

export function partialPath(finalPath: string): string {
  return `${finalPath}.partial`;
}

export function passLogPrefix(finalPath: string): string {
  return `${finalPath}.x265pass`;
}
