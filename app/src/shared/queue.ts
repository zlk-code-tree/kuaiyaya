import { isTargetTooLarge } from "./bitrate";
import type { EncoderKind, OutputPlan, ProgressEvent } from "./types";

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
  output?: OutputPlan;
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
  /** 正在压缩的每一条各自带进度，互不覆盖。 */
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
  /** 这一次正在压的全部条目，按列表原顺序。 */
  activeIds: string[];
  items: QueueItemSnapshot[];
  summary: QueueSummary | null;
}

/** 渲染进程只读。档位由主进程定，不做成设置。 */
export interface QueueConcurrencyInfo {
  limit: 1 | 2 | 3;
  source: "auto";
}

export const QUEUE_LEAD_PENDING = "正在确认这台设备这一次同时压几支。";

export function normalizeDeviceLimit(limit: number): 1 | 2 | 3 {
  if (!Number.isFinite(limit) || limit < 2) return 1;
  if (limit >= 3) return 3;
  return 2;
}

/** 队列说明用的一条草稿。reading 的还在读，probe 为空是读失败。 */
export interface CompressibleDraft {
  reading?: boolean;
  probe: unknown;
  skipped: boolean;
}

/**
 * 此刻真正要压的条数。还在读的、读失败的、会跳过的都不算。
 * 读完之前不要把它们算进去，避免说明从「按顺序」跳成「同时压 N 支」。
 */
export function countCompressibleDrafts(items: readonly CompressibleDraft[]): number {
  let count = 0;
  for (const item of items) {
    if (item.reading || item.probe == null || item.skipped) continue;
    count += 1;
  }
  return count;
}

/**
 * 说明里的数字：min(设备档位, 此刻真正要压的条数)。
 * 跳过的和不读得出来的不算。0 表示这一次没有要压的。
 */
export function displayedQueueSlots(deviceLimit: number, compressibleCount: number): number {
  const limit = normalizeDeviceLimit(deviceLimit);
  const count = Number.isFinite(compressibleCount) ? Math.max(0, Math.floor(compressibleCount)) : 0;
  return Math.min(limit, count);
}

/** 1 支或 0 支都写「按顺序一支一支压」，不写「同时压 1 支」。 */
export function queueConcurrencyLine(slots: number): string {
  if (slots >= 2) {
    return `这一次同时压 ${Math.floor(slots)} 支。由这台设备自动决定，单个失败不影响其余。`;
  }
  return "这一次按顺序一支一支压。由这台设备自动决定，单个失败不影响其余。";
}

/**
 * frozen 有值时，本轮这句话不再跟着完成、取消或列表变化改。
 * deviceLimit 还没从主进程读到时，不猜档位。
 */
export function resolveQueueLead(deviceLimit: number | null, compressibleCount: number, frozen: string | null): string {
  if (frozen != null) return frozen;
  if (deviceLimit == null) return QUEUE_LEAD_PENDING;
  return queueConcurrencyLine(displayedQueueSlots(deviceLimit, compressibleCount));
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

/**
 * 读取还没结束时不能开始。目标本身合法时，哪怕每支都会跳过，读完后仍可以开始。
 */
export function queueStartDisabled(opts: { started: boolean; ingesting: boolean; target: SharedTarget }): boolean {
  if (opts.started || opts.ingesting) return true;
  return !queueStartAllowed(opts.target);
}

/** 删到只剩一支时，只有已经填了的上限才带回准备页。 */
export function carriedCapMB(read: SharedTarget): number | null {
  return read.kind === "shared" ? read.mb : null;
}

/** 从准备页进入队列时写入输入框的文字。没填就空着，不要写成 1 或一半。 */
export function queueTargetTextFromReady(readyMB: number | null): string {
  if (readyMB == null || !Number.isFinite(readyMB)) return "";
  const mb = Math.round(readyMB);
  return mb >= 1 ? String(mb) : "";
}

export function queueSummaryLine(summary: QueueSummary): string {
  let line = `成功 ${summary.success}，失败 ${summary.failed}，已取消 ${summary.cancelled}。`;
  if (summary.skipped > 0) line += `另有 ${summary.skipped} 条已跳过。`;
  return line;
}
