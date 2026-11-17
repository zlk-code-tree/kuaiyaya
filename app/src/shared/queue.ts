import { defaultTargetMB, isTargetTooLarge } from "./bitrate";
import type { EncoderKind, ProgressEvent } from "./types";

export type QueuePhase = "idle" | "running" | "done";

export type QueueItemStatus = "waiting" | "running" | "success" | "failed" | "cancelled" | "skipped";

export interface QueueStartItem {
  id: string;
  filePath: string;
  name: string;
  targetMB: number;
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
  targetMB: number;
  status: QueueItemStatus;
  message: string;
  outputPath: string | null;
  outputBytes: number | null;
  inputBytes: number | null;
  exceededTarget: boolean;
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
  exceeded: number;
}

export interface QueueSnapshot {
  phase: QueuePhase;
  activeId: string | null;
  items: QueueItemSnapshot[];
  summary: QueueSummary | null;
}

export type SharedTarget =
  | { kind: "half" }
  | { kind: "shared"; mb: number }
  | { kind: "invalid" };

/** 空输入表示还没填，每支用自己的一半。填了合法整数才变成全队同一个参考目标。 */
export function readSharedTarget(raw: string): SharedTarget {
  const text = raw.trim();
  if (!text) return { kind: "half" };
  const value = Number(text);
  if (!Number.isFinite(value)) return { kind: "invalid" };
  const mb = Math.round(value);
  if (mb < 1) return { kind: "invalid" };
  return { kind: "shared", mb };
}

export function itemTargetMB(sizeBytes: number, sharedMB: number | null): number {
  return sharedMB == null ? defaultTargetMB(sizeBytes) : sharedMB;
}

export function targetSkipsItem(targetMB: number, sizeBytes: number): boolean {
  return isTargetTooLarge(targetMB, sizeBytes);
}

export function queueSummaryLine(summary: QueueSummary): string {
  let line = `成功 ${summary.success}，失败 ${summary.failed}，已取消 ${summary.cancelled}。`;
  if (summary.exceeded > 0) line += `有 ${summary.exceeded} 条实际体积超出了参考目标。`;
  if (summary.skipped > 0) line += `另有 ${summary.skipped} 条已跳过。`;
  return line;
}
