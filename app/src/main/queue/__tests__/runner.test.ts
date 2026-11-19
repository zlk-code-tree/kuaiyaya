import { describe, expect, it, vi } from "vitest";
import type { DoneEvent, ProbeInfo, ProgressEvent } from "../../../shared/types";
import type { StartDecision } from "../../../shared/license-machine";
import { MSG } from "../../../shared/messages";
import type { QueueStartItem } from "../../../shared/queue";
import { BatchQueue, type BatchQueueDeps, type QueueRunHooks } from "../runner";

function probe(id: string, sizeMB: number): ProbeInfo {
  const sizeBytes = sizeMB * 1024 * 1024;
  return {
    path: `/${id}.mp4`,
    name: `${id}.mp4`,
    sizeBytes,
    durationSec: 30,
    width: 1920,
    height: 1080,
    rotation: 0,
    displayWidth: 1920,
    displayHeight: 1080,
    videoCodec: "h264",
    hasAudio: true,
    container: "mp4",
  };
}

function source(id: string, sizeMB: number, targetMB: number | null): QueueStartItem {
  const info = probe(id, sizeMB);
  return {
    id,
    filePath: info.path,
    name: info.name,
    targetMB,
    sizeBytes: info.sizeBytes,
    durationSec: info.durationSec,
    displayWidth: info.displayWidth,
    displayHeight: info.displayHeight,
  };
}

function done(id: string, qualityReduced = false): DoneEvent {
  return {
    outputPath: `/${id}-out.mp4`,
    inputBytes: 80 * 1024 * 1024,
    outputBytes: 20 * 1024 * 1024,
    savedBytes: 1024,
    encoder: "x265",
    retried: false,
    qualityReduced,
    elapsedSec: 4,
  };
}

function progress(): ProgressEvent {
  return {
    encoder: "x265",
    phase: "single",
    ratio: 0.4,
    percent: 40,
    etaSec: 12,
    elapsedSec: 8,
    message: "正在按清晰度优先编码为 1920×1080 HEVC",
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  return { promise, resolve };
}

function harness(runJob: BatchQueueDeps["runJob"], prepare?: BatchQueueDeps["prepare"]): {
  queue: BatchQueue;
  decideStart: ReturnType<typeof vi.fn<() => Promise<StartDecision>>>;
  cancelJob: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const decideStart = vi.fn<() => Promise<StartDecision>>(async () => ({ action: "start" }));
  const cancelJob = vi.fn<() => Promise<void>>(async () => undefined);
  const queue = new BatchQueue({
    decideStart,
    cancelJob,
    prepare: prepare ?? (async (item) => ({ ok: true, probe: probe(item.id, 80) })),
    runJob,
  });
  return { queue, decideStart, cancelJob };
}

describe("batch queue", () => {
  it("runs items one after another and keeps progress on the active item only", async () => {
    const order: string[] = [];
    const activeDuring: string[][] = [];
    let release!: () => void;
    const started = deferred();
    const { queue, decideStart } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      if (item.id === "a") {
        hooks.onProgress(progress());
        activeDuring.push(
          queue.snapshot().items.filter((entry) => entry.progress).map((entry) => entry.id),
        );
        started.resolve();
        await new Promise<void>((resolve) => {
          release = () => {
            hooks.onDone(done("a"));
            resolve();
          };
        });
        return;
      }
      hooks.onDone(done(item.id, item.id === "c"));
    });
    const result = await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    expect(result.ok).toBe(true);
    await started.promise;
    expect(queue.snapshot().activeId).toBe("a");
    expect(activeDuring).toEqual([["a"]]);
    release();
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "success", "success"]);
    expect(queue.snapshot().items.every((item) => item.progress == null)).toBe(true);
    expect(queue.snapshot().items.map((item) => item.qualityReduced)).toEqual([false, false, true]);
    expect(queue.snapshot().summary).toMatchObject({ success: 3, failed: 0, cancelled: 0, skipped: 0 });
    expect(decideStart).toHaveBeenCalledTimes(1);
  });

  it("continues after one item fails", async () => {
    const order: string[] = [];
    const { queue } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      if (item.id === "b") {
        hooks.onFail({ message: "压缩后体积未小于原片，未保存结果；原片没有改动。" });
        return;
      }
      hooks.onDone(done(item.id));
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c"]);
    const items = queue.snapshot().items;
    expect(items.map((item) => item.status)).toEqual(["success", "failed", "success"]);
    expect(items[1]?.message).toBe("压缩后体积未小于原片，未保存结果；原片没有改动。");
  });

  it("fails only the item whose prepare step fails", async () => {
    const order: string[] = [];
    const { queue } = harness(
      async (item, _probe, hooks) => {
        order.push(item.id);
        hooks.onDone(done(item.id));
      },
      async (item) => {
        if (item.id === "b") return { ok: false, status: "failed", message: MSG.noWrite };
        return { ok: true, probe: probe(item.id, 80) };
      },
    );
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await queue.whenSettled();
    expect(order).toEqual(["a", "c"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "failed", "success"]);
    expect(queue.snapshot().items[1]?.message).toBe(MSG.noWrite);
  });

  it("cancels the current item and continues with the next", async () => {
    const order: string[] = [];
    let release!: () => void;
    const started = deferred();
    const { queue, decideStart, cancelJob } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      if (item.id === "a") {
        hooks.onProgress(progress());
        started.resolve();
        await new Promise<void>((resolve) => {
          release = () => {
            hooks.onFail({ message: MSG.cancelled, cancelled: true });
            resolve();
          };
        });
        return;
      }
      hooks.onDone(done(item.id));
    });
    cancelJob.mockImplementation(async () => release());
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await started.promise;
    queue.cancelItem("a");
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["cancelled", "success", "success"]);
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(decideStart).toHaveBeenCalledTimes(1);
  });

  it("cancels the running item and every item still waiting", async () => {
    const order: string[] = [];
    let release!: () => void;
    const started = deferred();
    const { queue, cancelJob } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      hooks.onProgress(progress());
      started.resolve();
      await new Promise<void>((resolve) => {
        release = () => {
          hooks.onFail({ message: MSG.cancelled, cancelled: true });
          resolve();
        };
      });
    });
    cancelJob.mockImplementation(async () => release());
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await started.promise;
    queue.cancelAll();
    await queue.whenSettled();
    expect(order).toEqual(["a"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(queue.snapshot().phase).toBe("done");
    expect(queue.snapshot().summary).toMatchObject({ success: 0, failed: 0, cancelled: 3 });
    expect(queue.isBusy()).toBe(false);
  });

  it("puts a failed retry at the tail while another item is running", async () => {
    const order: string[] = [];
    let release!: () => void;
    const started = deferred();
    const { queue, decideStart } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      const seen = order.filter((id) => id === item.id).length;
      if (item.id === "a" && seen === 1) {
        hooks.onFail({ message: MSG.encodeFail });
        return;
      }
      if (item.id === "b" && seen === 1) {
        hooks.onProgress(progress());
        started.resolve();
        await new Promise<void>((resolve) => {
          release = () => {
            hooks.onDone(done("b"));
            resolve();
          };
        });
        return;
      }
      hooks.onDone(done(item.id));
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await started.promise;
    queue.retryItem("a");
    expect(queue.snapshot().items.map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["running", "waiting", "waiting"]);
    expect(queue.snapshot().activeId).toBe("b");
    release();
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c", "a"]);
    expect(queue.snapshot().items.find((item) => item.id === "a")?.status).toBe("success");
    expect(decideStart).toHaveBeenCalledTimes(1);
  });

  it("retries failed items immediately once the queue has finished, still without another key decision", async () => {
    const order: string[] = [];
    const { queue, decideStart } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      const seen = order.filter((id) => id === item.id).length;
      if (item.id === "b" && seen === 1) {
        hooks.onFail({ message: MSG.encodeFail });
        return;
      }
      hooks.onDone(done(item.id));
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await queue.whenSettled();
    expect(queue.snapshot().phase).toBe("done");
    queue.retryFailed();
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c", "b"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "success", "success"]);
    expect(decideStart).toHaveBeenCalledTimes(1);
  });

  it("does not skip items when the cap is empty", async () => {
    const order: string[] = [];
    const { queue } = harness(async (item, _probe, hooks) => {
      order.push(item.id);
      expect(item.targetMB).toBeNull();
      hooks.onDone(done(item.id));
    });
    await queue.start([source("a", 10, null), source("b", 80, null)]);
    await queue.whenSettled();
    expect(order).toEqual(["a", "b"]);
    expect(queue.snapshot().items.every((item) => item.status === "success" && item.qualityReduced === false)).toBe(true);
    expect(queue.snapshot().summary).toMatchObject({ success: 2, skipped: 0, failed: 0 });
  });

  it("finishes with a summary when every item is already within the cap", async () => {
    const runJob = vi.fn(async (_item: QueueStartItem, _probe: ProbeInfo, _hooks: QueueRunHooks) => undefined);
    const { queue } = harness(
      runJob,
      async (item) => ({ ok: true, probe: probe(item.id, 10) }),
    );
    await queue.start([source("a", 10, 40), source("b", 10, 40)]);
    await queue.whenSettled();
    expect(runJob).not.toHaveBeenCalled();
    expect(queue.snapshot().phase).toBe("done");
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
    expect(queue.snapshot().items.every((item) => item.message === MSG.queueSkipped)).toBe(true);
    expect(queue.snapshot().summary).toMatchObject({ success: 0, failed: 0, skipped: 2 });
  });

  it("skips only the item that is not larger than its cap", async () => {
    const order: string[] = [];
    const { queue } = harness(
      async (item, _probe, hooks) => {
        order.push(item.id);
        hooks.onDone(done(item.id));
      },
      async (item) => ({ ok: true, probe: probe(item.id, item.id === "b" ? 10 : 80) }),
    );
    await queue.start([source("a", 80, 40), source("b", 10, 40), source("c", 80, 40)]);
    await queue.whenSettled();
    expect(order).toEqual(["a", "c"]);
    const items = queue.snapshot().items;
    expect(items.map((item) => item.status)).toEqual(["success", "skipped", "success"]);
    expect(items[1]?.message).toBe(MSG.queueSkipped);
    expect(queue.snapshot().summary).toMatchObject({ success: 2, failed: 0, skipped: 1 });
  });

  it("does not run the queue when the key decision blocks", async () => {
    const runJob = vi.fn(async (_item: QueueStartItem, _probe: ProbeInfo, _hooks: QueueRunHooks) => undefined);
    const { queue, decideStart } = harness(runJob);
    decideStart.mockResolvedValueOnce({ action: "block", code: "network", message: MSG.networkStart });
    const blocked = await queue.start([source("a", 80, 40), source("b", 80, 40)]);
    expect(blocked).toEqual({ ok: false, code: "network", message: MSG.networkStart });
    expect(runJob).not.toHaveBeenCalled();
    expect(queue.isBusy()).toBe(false);

    const allowed = await queue.start([source("a", 80, 40), source("b", 80, 40)]);
    await queue.whenSettled();
    expect(allowed.ok).toBe(true);
    expect(runJob).toHaveBeenCalledTimes(2);
    expect(decideStart).toHaveBeenCalledTimes(2);
  });
});
