import { isTargetTooLarge } from "./bitrate";
import type { EncoderKind, ProgressEvent } from "./types";

export type QueuePhase = "idle" | "running" | "done";

export type QueueItemStatus = "waiting" | "running" | "success" | "failed" | "cancelled" | "skipped";

export interface QueueStartItem {
  id: string;
  filePath: string;
  name: string;
  /** null：这支按清晰度优先，不设上限。 */
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
  /** null：按清晰度自动压。正整数：全队共用的上限。 */
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

/** 空输入是清晰度优先，不再当成原片一半。填了合法整数才是全队共用的上限。 */
export function readSharedTarget(raw: string): SharedTarget {
  const text = raw.trim();
  if (!text) return { kind: "quality" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  const mb = Math.round(value);
  if (mb < 1) return { kind: "invalid" };
  return { kind: "shared", mb };
}

/** 没填时保持 null，不要把一半填进去。 */
export function itemTargetMB(_sizeBytes: number, sharedMB: number | null): number | null {
  return sharedMB;
}

export function targetSkipsItem(targetMB: number | null, sizeBytes: number): boolean {
  if (targetMB == null) return false;
  return isTargetTooLarge(targetMB, sizeBytes);
}

/** 非法数字才不能开始。全部都会被跳过时仍然允许开始，点了之后出汇总。 */
export function queueStartAllowed(read: SharedTarget): boolean {
  return read.kind !== "invalid";
}

/** 删到只剩一支时，只有已经填了的上限才带回准备页。 */
export function carriedCapMB(read: SharedTarget): number | null {
  return read.kind === "shared" ? read.mb : null;
}

export function queueSummaryLine(summary: QueueSummary): string {
  let line = `成功 ${summary.success}，失败 ${summary.failed}，已取消 ${summary.cancelled}。`;
  if (summary.skipped > 0) line += `另有 ${summary.skipped} 条已跳过。`;
  return line;
}
