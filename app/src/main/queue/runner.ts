import { normalizeOutputPlan } from "../../shared/filename";
import type { DoneEvent, FailEvent, OutputPlan, ProbeInfo, ProgressEvent } from "../../shared/types";
import type { StartDecision } from "../../shared/license-machine";
import { MSG } from "../../shared/messages";
import {
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
  prepare: (item: { id: string; filePath: string; targetMB: number | null; outputDirectory?: string | null }) => Promise<PrepareResult>;
  /** 必须走现有 CompressJob（或测试替身），不要在队列里另写编码。每条运行中的条目各调一次。 */
  runJob: (item: QueueItemSnapshot, probe: ProbeInfo, hooks: QueueRunHooks, output: OutputPlan) => Promise<void>;
  /** 只取消这一支对应的 Job。 */
  cancelJob: (itemId: string) => Promise<void>;
  /**
   * 本轮开始时读一次设备档位。重试（排到队尾，或整批结束后立刻再压）沿用这次的结果，不再重读。
   * 中途某一支硬编回退软编，也不要靠再次调用它来降档。
   */
  concurrencyLimit: () => Promise<number> | number;
  onUpdate?: (snapshot: QueueSnapshot) => void;
}

function seed(input: QueueStartItem): QueueItemSnapshot {
  const rounded = input.targetMB == null ? null : Math.round(input.targetMB);
  const targetMB = rounded != null && rounded >= 1 ? rounded : null;
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
    qualityReduced: false,
    elapsedSec: null,
    encoder: null,
    progress: null,
  };
}

function cloneItem(item: QueueItemSnapshot): QueueItemSnapshot {
  return { ...item, progress: item.progress ? { ...item.progress } : null };
}

function clampLimit(value: number): 1 | 2 | 3 {
  if (!Number.isFinite(value) || value < 2) return 1;
  if (value >= 3) return 3;
  return 2;
}

/**
 * 有限并发的批量队列。编码、缩放、临时文件清理都留在各自的 CompressJob。
 * 同时处于准备或编码中的条目最多 batchLimit 条；准备失败或跳过会立刻让出名额。
 * Key 只在 start() 里决定一次。本轮档位在 start() 里定死，重试不再改。
 */
export class BatchQueue {
  private items: QueueItemSnapshot[] = [];
  private outputPlan: OutputPlan = { directory: null, pattern: null };
  private phase: QueuePhase = "idle";
  private batchLimit: 1 | 2 | 3 = 1;
  private inflight = 0;
  private readonly claimed = new Set<string>();
  private starting = false;
  private deciding = false;
  private abortStart = false;
  private pending: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: BatchQueueDeps) {}

  isBusy(): boolean {
    return this.starting || this.deciding || this.inflight > 0 || this.phase === "running";
  }

  snapshot(): QueueSnapshot {
    return {
      phase: this.phase,
      activeIds: this.items.filter((item) => item.status === "running").map((item) => item.id),
      items: this.items.map(cloneItem),
      summary: this.phase === "done" ? this.summarize() : null,
    };
  }

  async start(input: QueueStartItem[], output?: OutputPlan): Promise<QueueStartResult> {
    const job = this.begin(input, output);
    this.pending = this.pending.then(() => job.then(() => undefined, () => undefined));
    return job;
  }

  async whenSettled(): Promise<void> {
    await this.pending;
    // 空位续跑会在前一条的 finally 里把新任务接到 tail 后面。
    // 这里要跟着新的 tail 走，不能只等开始时已经挂上的那一段。
    for (;;) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail && this.inflight === 0 && !this.starting && !this.deciding) return;
    }
  }

  cancelItem(id: string): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    if (item.status === "waiting") {
      item.status = "cancelled";
      item.message = MSG.cancelled;
      item.progress = null;
      this.emit();
      this.settle();
      return;
    }
    if (item.status === "running") void this.deps.cancelJob(item.id).catch(() => undefined);
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
    for (const item of this.items) {
      if (item.status === "running") void this.deps.cancelJob(item.id).catch(() => undefined);
    }
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

  private async begin(input: QueueStartItem[], output?: OutputPlan): Promise<QueueStartResult> {
    if (this.phase === "running" || this.deciding || this.starting || this.inflight > 0) {
      return { ok: false, code: "busy", message: "正在处理其他任务，请稍候。" };
    }
    if (input.length === 0) return { ok: false, message: "没有可以压缩的视频。" };
    this.starting = true;
    this.abortStart = false;
    this.deciding = true;
    this.outputPlan = normalizeOutputPlan(output);
    try {
      const decision = await this.deps.decideStart();
      if (this.abortStart) return { ok: false, code: "cancelled", message: MSG.cancelled };
      if (decision.action !== "start") {
        const code = decision.action === "block" ? decision.code : "network";
        const message = decision.action === "block" ? decision.message : MSG.networkStart;
        return { ok: false, code, message };
      }
      this.batchLimit = await this.readLimit();
      if (this.abortStart) return { ok: false, code: "cancelled", message: MSG.cancelled };
      this.items = input.map(seed);
      this.phase = "running";
      this.emit();
      this.launch();
      return { ok: true };
    } finally {
      this.deciding = false;
      this.starting = false;
    }
  }

  private async readLimit(): Promise<1 | 2 | 3> {
    try {
      return clampLimit(await this.deps.concurrencyLimit());
    } catch {
      return 1;
    }
  }

  private resume(): void {
    if (this.items.some((item) => item.status === "waiting")) this.phase = "running";
    this.emit();
    this.launch();
  }

  private requeue(item: QueueItemSnapshot): void {
    item.status = "waiting";
    item.message = "";
    item.progress = null;
    item.outputPath = null;
    item.outputBytes = null;
    item.inputBytes = null;
    item.qualityReduced = false;
    item.elapsedSec = null;
    item.encoder = null;
    this.items = this.items.filter((entry) => entry !== item).concat(item);
  }

  /**
   * 有空位就按原顺序启动下一条。await 会把准备让回事件循环，
   * 所以这一轮循环能在任何一条编码开始前把空位填满。
   */
  private launch(): void {
    while (this.inflight < this.batchLimit) {
      const next = this.items.find((item) => item.status === "waiting" && !this.claimed.has(item.id));
      if (!next) return;
      this.claimed.add(next.id);
      this.inflight += 1;
      const run = this.runOne(next).finally(() => {
        this.inflight -= 1;
        this.claimed.delete(next.id);
        this.launch();
        this.settle();
      });
      this.tail = this.tail.then(() => run.then(() => undefined, () => undefined));
    }
  }

  private settle(): void {
    if (this.inflight > 0) return;
    if (this.items.some((item) => item.status === "waiting" || item.status === "running")) {
      if (this.items.some((item) => item.status === "waiting")) this.launch();
      return;
    }
    if (this.phase !== "running") return;
    this.phase = "done";
    this.emit();
    if (this.items.some((item) => item.status === "waiting")) {
      this.phase = "running";
      this.launch();
    }
  }

  private async runOne(item: QueueItemSnapshot): Promise<void> {
    if (item.status !== "waiting") return;
    let prepared: PrepareResult;
    try {
      prepared = await this.deps.prepare({
        id: item.id,
        filePath: item.filePath,
        targetMB: item.targetMB,
        outputDirectory: this.outputPlan.directory,
      });
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
        item.qualityReduced = event.qualityReduced;
        item.elapsedSec = event.elapsedSec;
        item.encoder = event.encoder;
        item.message = "";
      },
      onFail: (event) => {
        saw = true;
        item.status = event.cancelled ? "cancelled" : "failed";
        item.progress = null;
        item.message = event.message;
        item.elapsedSec = null;
        item.encoder = null;
      },
    };
    try {
      await this.deps.runJob(cloneItem(item), prepared.probe, hooks, this.outputPlan);
    } catch (err) {
      if (!saw && item.status === "running") {
        item.status = "failed";
        item.progress = null;
        item.message = err instanceof Error && err.message ? err.message : MSG.encodeFail;
      }
    }
    if (!saw && item.status === "running") {
      item.status = "failed";
      item.progress = null;
      item.message = MSG.encodeFail;
    }
    this.emit();
  }

  private summarize(): QueueSummary {
    const summary: QueueSummary = { success: 0, failed: 0, cancelled: 0, skipped: 0 };
    for (const item of this.items) {
      if (item.status === "success") summary.success += 1;
      else if (item.status === "failed") summary.failed += 1;
      else if (item.status === "cancelled") summary.cancelled += 1;
      else if (item.status === "skipped") summary.skipped += 1;
    }
    return summary;
  }

  private emit(): void {
    this.deps.onUpdate?.(this.snapshot());
  }
}
