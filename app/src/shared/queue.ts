import { isTargetTooLarge } from "./bitrate";
import type { EncoderKind, ProgressEvent } from "./types";

export type QueuePhase = "idle" | "running" | "done";

export type QueueItemStatus = "waiting" | "running" | "success" | "failed" | "cancelled" | "skipped";

export interface QueueStartItem {
  id: string;
  filePath: string;
  name: string;
  /** null 表示没填，这支按清晰度优先压，不预填一半。 */
  targetMB: number | null;
  sizeBytes: number;
  durationSec: number;
  displayWidth: number;
  displayHeight: number;
}

export interface QueueStartRequest {
  items: QueueStartItem[];
}

export interface QueueStartResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface QueueRetryRequest {
  id?: string;
  allFailed?: boolean;
}

export interface QueueItemSnapshot {
  id: string;
  filePath: string;
  name: string;
  sizeBytes: number;
  durationSec: number;
  displayWidth: number;
  displayHeight: number;
  targetMB: number | null;
  status: QueueItemStatus;
  message: string;
  outputPath: string | null;
  outputBytes: number | null;
  inputBytes: number | null;
  qualityReduced: boolean;
  elapsedSec: number | null;
  encoder: EncoderKind | null;
  /** 只有正在压缩的那一条会带进度，避免和另一套计时对不上。 */
  progress: ProgressEvent | null;
}

export interface QueueSummary {
  success: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface QueueSnapshot {
  phase: QueuePhase;
  activeId: string | null;
  items: QueueItemSnapshot[];
  summary: QueueSummary | null;
}

export type SharedTarget =
  | { kind: "quality" }
  | { kind: "shared"; mb: number }
  | { kind: "invalid" };

/** 空输入表示没填，每支走清晰度优先。填了合法整数才是全队共用的上限。 */
export function readSharedTarget(raw: string): SharedTarget {
  const text = raw.trim();
  if (!text) return { kind: "quality" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  const mb = Math.round(value);
  if (mb < 1) return { kind: "invalid" };
  return { kind: "shared", mb };
}

/** 没填时返回 null，不再把原片一半填进要压的条目。 */
export function itemTargetMB(_sizeBytes: number, sharedMB: number | null): number | null {
  return sharedMB;
}

export function targetSkipsItem(targetMB: number | null, sizeBytes: number): boolean {
  if (targetMB == null) return false;
  return isTargetTooLarge(targetMB, sizeBytes);
}

export function targetLabel(targetMB: number | null): string {
  return targetMB == null ? "按清晰度自动压" : `上限 ${targetMB} MB`;
}

/** 全部都会被跳过时仍允许开始，点了之后由队列走完并出汇总。 */
export function queueCanStart(input: {
  started: boolean;
  target: SharedTarget;
  items: Array<{ readable: boolean; sizeBytes: number }>;
}): boolean {
  if (input.started || input.target.kind === "invalid" || input.items.length === 0) return false;
  const limit = input.target.kind === "shared" ? input.target.mb : null;
  if (input.items.some((item) => item.readable && !targetSkipsItem(limit, item.sizeBytes))) return true;
  return input.items.every((item) => item.readable && targetSkipsItem(limit, item.sizeBytes));
}

export function queueSummaryLine(summary: QueueSummary): string {
  let line = `成功 ${summary.success}，失败 ${summary.failed}，已取消 ${summary.cancelled}。`;
  if (summary.skipped > 0) line += `另有 ${summary.skipped} 条已跳过。`;
  return line;
}
