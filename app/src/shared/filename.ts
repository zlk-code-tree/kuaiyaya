/** 纯字符串版，渲染进程也可调用（不依赖 node:path）。 */

import type { Size } from "./scale";
import type { OutputPlan } from "./types";

export function outputTag(size?: Size): string {
  if (!size) return "1080p";
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height);
  if (long >= 1920 || short >= 1080) return "1080p";
  if (short >= 720 || long >= 1280) return "720p";
  return `${short}p`;
}

export function fileStem(inputPath: string): string {
  const file = inputPath.split(/[/\\]/).pop() ?? "video";
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

export function suggestedOutputName(inputPath: string, size?: Size): string {
  return `${fileStem(inputPath)}_${outputTag(size)}.mp4`;
}

/**
 * 式样留空时沿用清晰度后缀：1080p 输出就是「原名_1080p.mp4」。
 * 填了式样才替换 {originalStem}，不再跟清晰度走。
 */
export function plannedOutputName(inputPath: string, size: Size | undefined, pattern?: string | null): string {
  const custom = pattern?.trim() ?? "";
  if (!custom) return suggestedOutputName(inputPath, size);
  return renderPatternName(inputPath, custom);
}

export function patternProblem(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return null;
  if (text.length > 160) return "文件名太长。";
  if (/[/\\]/.test(text)) return "文件名不能包含文件夹。";
  if (hasControl(text) || /[<>:"|?*]/.test(text)) return "文件名包含不能使用的字符。";
  return null;
}

export function normalizeOutputPlan(raw?: { directory?: string | null; pattern?: string | null } | null): OutputPlan {
  const directory = typeof raw?.directory === "string" ? raw.directory.trim() : "";
  const pattern = typeof raw?.pattern === "string" ? raw.pattern.trim() : "";
  return { directory: directory || null, pattern: pattern || null };
}

/** 不检查是否绝对路径。主进程另外要求所选文件夹必须是绝对路径。 */
export function outputPlanProblem(plan: OutputPlan): string | null {
  const patternError = patternProblem(plan.pattern ?? "");
  if (patternError) return patternError;
  if (plan.directory?.includes("\0")) return "所选文件夹无效。";
  return null;
}

export function renderPatternName(inputPath: string, pattern: string): string {
  const stem = safeStem(inputPath);
  let name = pattern.trim().split("{originalStem}").join(stem);
  name = stripControl(name.replace(/[/\\]/g, "")).trim();
  if (!name || name === "." || name === "..") return `${stem}_1080p.mp4`;
  if (!/\.mp4$/i.test(name)) name += ".mp4";
  return name;
}

export function suffixedFileName(fileName: string, index: number): string {
  if (index < 2) return fileName;
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return `${stem} (${index})${ext}`;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function stripControl(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 31 || code === 127) continue;
    out += text[i] ?? "";
  }
  return out;
}

function safeStem(inputPath: string): string {
  const cleaned = stripControl(fileStem(inputPath)).trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "video";
  return cleaned;
}
