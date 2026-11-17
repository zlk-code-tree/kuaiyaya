import type { DoneEvent, FailEvent, ProbeInfo, ProgressEvent } from "../../shared/types";
import type { StartDecision } from "../../shared/license-machine";
import { MSG } from "../../shared/messages";
import {
  itemTargetMB,
  targetSkipsItem,
  type QueueItemSnapshot,
  type QueuePhase,
  type QueueSnapshot,
  type QueueStartItem,
  type QueueStartResult,
  type QueueSummary,
} from "../../shared/queue";

export interface PrepareResultOk {
  ok: true;
  probe: ProbeInfo;
}

export interface PrepareResultNo {
  ok: false;
  status: "failed" | "skipped";
  message: string;
}

export type PrepareResult = PrepareResultOk | PrepareResultNo;

export interface QueueRunHooks {
  onProgress: (event: ProgressEvent) => void;
  onDone: (event: DoneEvent) => void;
  onFail: (event: FailEvent) => void;
}

export interface BatchQueueDeps {
  /** 一轮开始时调用一次。通过后，本轮剩余条目和重试都不再调用。 */
  decideStart: () => Promise<StartDecision>;
  prepare: (item: { id: string; filePath: string; targetMB: number }) => Promise<PrepareResult>;
  /** 必须走现有 CompressJob（或测试替身），不要在队列里另写编码。 */
  runJob: (item: QueueItemSnapshot, probe: ProbeInfo, hooks: QueueRunHooks) => Promise<void>;
  cancelJob: () => Promise<void>;
  onUpdate?: (snapshot: QueueSnapshot) => void;
}

function seed(input: QueueStartItem): QueueItemSnapshot {
  const targetMB = Number.isFinite(input.targetMB) ? Math.round(input.targetMB) : itemTargetMB(input.sizeBytes, null);
  return {
    id: input.id,
    filePath: input.filePath,
    name: input.name,
    sizeBytes: input.sizeBytes,
    durationSec: input.durationSec,
    displayWidth: input.displayWidth,
    displayHeight: input.displayHeight,
    targetMB,
    status: "waiting",
    message: "",
    outputPath: null,
    outputBytes: null,
    inputBytes: null,
    exceededTarget: false,
    elapsedSec: null,
    encoder: null,
    progress: null,
  };
}

function cloneItem(item: QueueItemSnapshot): QueueItemSnapshot {
  return { ...item, progress: item.progress ? { ...item.progress } : null };
}

/**
 * 串行批量队列。编码、缩放、临时文件清理都留在 CompressJob。
 * Key 只在 start() 里决定一次。
 */
export class BatchQueue {
  private items: QueueItemSnapshot[] = [];
  private phase: QueuePhase = "idle";
  private activeId: string | null = null;
  private starting = false;
  private deciding = false;
  private pumping = false;
  private abortStart = false;
  private pending: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BatchQueueDeps) {}

  isBusy(): boolean {
    return this.starting || this.deciding || this.pumping || this.phase === "running";
  }

  snapshot(): QueueSnapshot {
    return {
      phase: this.phase,
      activeId: this.activeId,
      items: this.items.map(cloneItem),
      summary: this.phase === "done" ? this.summarize() : null,
    };
  }

  async start(input: QueueStartItem[]): Promise<QueueStartResult> {
    const job = this.begin(input);
    this.pending = this.pending.then(() => job.then(() => undefined, () => undefined));
    return job;
  }

  async whenSettled(): Promise<void> {
    await this.pending;
    await this.tail;
  }

  cancelItem(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.status === "waiting") {
      item.status = "cancelled";
      item.message = MSG.cancelled;
      item.progress = null;
      this.emit();
      return;
    }
    if (item.status === "running") void this.deps.cancelJob().catch(() => undefined);
  }

  cancelAll(): void {
    this.abortStart = true;
    for (const item of this.items) {
      if (item.status === "waiting") {
        item.status = "cancelled";
        item.message = MSG.cancelled;
        item.progress = null;
      }
    }
    if (this.items.some((item) => item.status === "running")) void this.deps.cancelJob().catch(() => undefined);
    this.emit();
  }

  async cancelAllAndWait(): Promise<void> {
    this.cancelAll();
    await this.whenSettled();
  }

  retryItem(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || (item.status !== "failed" && item.status !== "cancelled")) return;
    this.requeue(item);
    this.resume();
  }

  retryFailed(): void {
    const failed = this.items.filter((item) => item.status === "failed");
    if (failed.length === 0) return;
    for (const item of failed) this.requeue(item);
    this.resume();
  }

  private async begin(input: QueueStartItem[]): Promise<QueueStartResult> {
    if (this.phase === "running" || this.deciding || this.starting) {
      return { ok: false, code: "busy", message: "正在处理其他任务，请稍候。" };
    }
    if (input.length === 0) return { ok: false, message: "没有可以压缩的视频。" };
    this.starting = true;
    this.abortStart = false;
    this.deciding = true;
    try {
      const decision = await this.deps.decideStart();
      if (this.abortStart) return { ok: false, code: "cancelled", message: MSG.cancelled };
      if (decision.action !== "start") {
        const code = decision.action === "block" ? decision.code : "network";
        const message = decision.action === "block" ? decision.message : MSG.networkStart;
        return { ok: false, code, message };
      }
      this.items = input.map(seed);
      this.activeId = null;
      this.phase = "running";
      this.emit();
      this.kick();
      return { ok: true };
    } finally {
      this.deciding = false;
      this.starting = false;
    }
  }

  private resume(): void {
    if (this.items.some((item) => item.status === "waiting")) this.phase = "running";
    this.emit();
    this.kick();
  }

  private requeue(item: QueueItemSnapshot): void {
    item.status = "waiting";
    item.message = "";
    item.progress = null;
    item.outputPath = null;
    item.outputBytes = null;
    item.inputBytes = null;
    item.exceededTarget = false;
    item.elapsedSec = null;
    item.encoder = null;
    this.items = this.items.filter((entry) => entry !== item).concat(item);
  }

  private kick(): void {
    if (this.pumping) return;
    if (!this.items.some((item) => item.status === "waiting")) return;
    this.pumping = true;
    const run = this.pump().finally(() => {
      this.pumping = false;
    });
    this.tail = this.tail.then(() => run).then(() => undefined, () => undefined);
  }

  private async pump(): Promise<void> {
    for (;;) {
      const next = this.items.find((item) => item.status === "waiting");
      if (!next) {
        this.phase = "done";
        this.activeId = null;
        this.emit();
        if (this.items.some((item) => item.status === "waiting")) {
          this.phase = "running";
          continue;
        }
        return;
      }
      this.phase = "running";
      await this.runOne(next);
    }
  }

  private async runOne(item: QueueItemSnapshot): Promise<void> {
    if (item.status !== "waiting") return;
    let prepared: PrepareResult;
    try {
      prepared = await this.deps.prepare({ id: item.id, filePath: item.filePath, targetMB: item.targetMB });
    } catch (err) {
      if (item.status !== "waiting") return;
      item.status = "failed";
      item.message = err instanceof Error && err.message ? err.message : MSG.encodeFail;
      item.progress = null;
      this.emit();
      return;
    }
    if (item.status !== "waiting") return;
    if (!prepared.ok) {
      item.status = prepared.status;
      item.message = prepared.message;
      item.progress = null;
      this.emit();
      return;
    }
    item.filePath = prepared.probe.path;
    item.name = prepared.probe.name;
    item.sizeBytes = prepared.probe.sizeBytes;
    item.durationSec = prepared.probe.durationSec;
    item.displayWidth = prepared.probe.displayWidth;
    item.displayHeight = prepared.probe.displayHeight;
    if (targetSkipsItem(item.targetMB, prepared.probe.sizeBytes)) {
      item.status = "skipped";
      item.message = MSG.queueSkipped;
      item.progress = null;
      this.emit();
      return;
    }
    item.status = "running";
    item.progress = null;
    item.message = "";
    this.activeId = item.id;
    this.emit();
    let saw = false;
    const hooks: QueueRunHooks = {
      onProgress: (event) => {
        if (item.status !== "running") return;
        item.progress = event;
        item.elapsedSec = event.elapsedSec;
        this.emit();
      },
      onDone: (event) => {
        saw = true;
        item.status = "success";
        item.progress = null;
        item.outputPath = event.outputPath;
        item.outputBytes = event.outputBytes;
        item.inputBytes = event.inputBytes;
        item.exceededTarget = event.exceededTarget;
        item.elapsedSec = event.elapsedSec;
        item.encoder = event.encoder;
        item.message = "";
        if (this.activeId === item.id) this.activeId = null;
      },
      onFail: (event) => {
        saw = true;
        item.status = event.cancelled ? "cancelled" : "failed";
        item.progress = null;
        item.message = event.message;
        item.elapsedSec = null;
        item.encoder = null;
        if (this.activeId === item.id) this.activeId = null;
      },
    };
    try {
      await this.deps.runJob(cloneItem(item), prepared.probe, hooks);
    } catch (err) {
      if (!saw && item.status === "running") {
        item.status = "failed";
        item.progress = null;
        item.message = err instanceof Error && err.message ? err.message : MSG.encodeFail;
        if (this.activeId === item.id) this.activeId = null;
      }
    }
    if (!saw && item.status === "running") {
      item.status = "failed";
      item.progress = null;
      item.message = MSG.encodeFail;
      if (this.activeId === item.id) this.activeId = null;
    }
    this.emit();
  }

  private summarize(): QueueSummary {
    const summary: QueueSummary = { success: 0, failed: 0, cancelled: 0, skipped: 0, exceeded: 0 };
    for (const item of this.items) {
      if (item.status === "success") {
        summary.success += 1;
        if (item.exceededTarget) summary.exceeded += 1;
      } else if (item.status === "failed") summary.failed += 1;
      else if (item.status === "cancelled") summary.cancelled += 1;
      else if (item.status === "skipped") summary.skipped += 1;
    }
    return summary;
  }

  private emit(): void {
    this.deps.onUpdate?.(this.snapshot());
  }
}
