import { describe, expect, it, vi } from "vitest";
import type { DoneEvent, ProbeInfo, ProgressEvent } from "../../../shared/types";
import type { StartDecision } from "../../../shared/license-machine";
import { MSG } from "../../../shared/messages";
import { displayedQueueSlots, queueConcurrencyLine, type QueueStartItem } from "../../../shared/queue";
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

function harness(runJob: BatchQueueDeps["runJob"], prepare?: BatchQueueDeps["prepare"], limit = 1): {
  queue: BatchQueue;
  decideStart: ReturnType<typeof vi.fn<() => Promise<StartDecision>>>;
  cancelJob: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
  concurrencyLimit: ReturnType<typeof vi.fn<() => Promise<number>>>;
} {
  const decideStart = vi.fn<() => Promise<StartDecision>>(async () => ({ action: "start" }));
  const cancelJob = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  const concurrencyLimit = vi.fn<() => Promise<number>>(async () => limit);
  const queue = new BatchQueue({
    decideStart,
    cancelJob,
    concurrencyLimit,
    prepare: prepare ?? (async (item) => ({ ok: true, probe: probe(item.id, 80) })),
    runJob,
  });
  return { queue, decideStart, cancelJob, concurrencyLimit };
}

describe("batch queue", () => {
  it("with limit 1 runs items one after another and keeps progress on the active item only", async () => {
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
    expect(queue.snapshot().activeIds).toEqual(["a"]);
    expect(activeDuring).toEqual([["a"]]);
    release();
    await queue.whenSettled();
    expect(order).toEqual(["a", "b", "c"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "success", "success"]);
    expect(queue.snapshot().items.every((item) => item.progress == null)).toBe(true);
    expect(queue.snapshot().items.map((item) => item.qualityReduced)).toEqual([false, false, true]);
    expect(queue.snapshot().activeIds).toEqual([]);
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
    expect(queue.snapshot().activeIds).toEqual(["b"]);
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

interface Held {
  started: Promise<void>;
  pulse: (event: ProgressEvent) => void;
  finish: (kind: "done" | "fail" | "cancel") => void;
}

function controllable(): {
  runJob: BatchQueueDeps["runJob"];
  gate: (id: string) => Promise<Held>;
  order: () => string[];
  resetPeak: () => void;
  maxActive: () => number;
} {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates = new Map<string, Held>();
  const waiters = new Map<string, Array<(gate: Held) => void>>();

  const publish = (id: string, gate: Held) => {
    gates.set(id, gate);
    const pending = waiters.get(id);
    if (!pending) return;
    waiters.delete(id);
    for (const wake of pending) wake(gate);
  };

  const runJob: BatchQueueDeps["runJob"] = async (item, _probe, hooks) => {
    order.push(item.id);
    active += 1;
    maxActive = Math.max(maxActive, active);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    await new Promise<void>((resolve) => {
      const gate: Held = {
        started,
        pulse: (event) => hooks.onProgress(event),
        finish: (kind) => {
          if (gates.get(item.id) === gate) gates.delete(item.id);
          if (kind === "fail") hooks.onFail({ message: MSG.encodeFail });
          else if (kind === "cancel") hooks.onFail({ message: MSG.cancelled, cancelled: true });
          else hooks.onDone(done(item.id, item.id === "c"));
          resolve();
        },
      };
      publish(item.id, gate);
      resolveStarted();
    });
    active -= 1;
  };

  return {
    runJob,
    order: () => order.slice(),
    maxActive: () => maxActive,
    resetPeak: () => {
      maxActive = active;
    },
    gate: (id) => {
      const existing = gates.get(id);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push(resolve);
        waiters.set(id, list);
      });
    },
  };
}

describe("batch queue concurrency", () => {
  it("runs two of three items and gives a freed slot to the next one", async () => {
    const jobs = controllable();
    const line = queueConcurrencyLine(displayedQueueSlots(2, 3));
    const { queue, decideStart, concurrencyLimit } = harness(jobs.runJob, undefined, 2);
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    const first = await jobs.gate("a");
    const second = await jobs.gate("b");
    expect(jobs.order()).toEqual(["a", "b"]);
    expect(queue.snapshot().activeIds).toEqual(["a", "b"]);
    expect(queue.snapshot().items.find((item) => item.id === "c")?.status).toBe("waiting");
    first.pulse({ ...progress(), percent: 40, elapsedSec: 8 });
    second.pulse({ ...progress(), percent: 70, elapsedSec: 3, etaSec: 4 });
    const mid = queue.snapshot().items;
    expect(mid.find((item) => item.id === "a")?.progress?.percent).toBe(40);
    expect(mid.find((item) => item.id === "b")?.progress?.percent).toBe(70);
    expect(mid.find((item) => item.id === "a")?.elapsedSec).toBe(8);
    expect(mid.find((item) => item.id === "b")?.elapsedSec).toBe(3);
    expect(mid.find((item) => item.id === "c")?.progress).toBeNull();
    first.finish("done");
    await jobs.gate("c");
    expect(queue.snapshot().activeIds).toEqual(["b", "c"]);
    expect(line).toBe("这一次同时压 2 支。由这台设备自动决定，单个失败不影响其余。");
    second.finish("done");
    (await jobs.gate("c")).finish("done");
    await queue.whenSettled();
    expect(jobs.order()).toEqual(["a", "b", "c"]);
    expect(jobs.maxActive()).toBe(2);
    expect(queue.snapshot().activeIds).toEqual([]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "success", "success"]);
    expect(decideStart).toHaveBeenCalledTimes(1);
    expect(concurrencyLimit).toHaveBeenCalledTimes(1);
    expect(line).toBe("这一次同时压 2 支。由这台设备自动决定，单个失败不影响其余。");
  });

  it("keeps the sibling running when one item fails and fills the slot", async () => {
    const jobs = controllable();
    const { queue } = harness(jobs.runJob, undefined, 2);
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    (await jobs.gate("a")).finish("fail");
    await jobs.gate("b");
    await jobs.gate("c");
    expect(queue.snapshot().items.find((item) => item.id === "a")?.status).toBe("failed");
    expect(queue.snapshot().items.find((item) => item.id === "b")?.status).toBe("running");
    expect(queue.snapshot().activeIds).toEqual(["b", "c"]);
    (await jobs.gate("b")).finish("done");
    (await jobs.gate("c")).finish("done");
    await queue.whenSettled();
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["failed", "success", "success"]);
    expect(jobs.maxActive()).toBe(2);
  });

  it("frees only the cancelled item's slot and lets the next waiter start", async () => {
    const jobs = controllable();
    const { queue, decideStart, cancelJob } = harness(jobs.runJob, undefined, 2);
    cancelJob.mockImplementation(async (id) => {
      (await jobs.gate(id)).finish("cancel");
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await jobs.gate("a");
    await jobs.gate("b");
    queue.cancelItem("a");
    await jobs.gate("c");
    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith("a");
    expect(queue.snapshot().items.find((item) => item.id === "a")?.status).toBe("cancelled");
    expect(queue.snapshot().items.find((item) => item.id === "b")?.status).toBe("running");
    expect(queue.snapshot().activeIds).toEqual(["b", "c"]);
    (await jobs.gate("b")).finish("done");
    (await jobs.gate("c")).finish("done");
    await queue.whenSettled();
    expect(jobs.order()).toEqual(["a", "b", "c"]);
    expect(decideStart).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting item without changing the running slots", async () => {
    const jobs = controllable();
    const { queue, cancelJob } = harness(jobs.runJob, undefined, 2);
    await queue.start([
      source("a", 80, 40),
      source("b", 80, 40),
      source("c", 80, 40),
      source("d", 80, 40),
    ]);
    await jobs.gate("a");
    await jobs.gate("b");
    queue.cancelItem("c");
    expect(cancelJob).not.toHaveBeenCalled();
    expect(queue.snapshot().items.find((item) => item.id === "c")?.status).toBe("cancelled");
    expect(queue.snapshot().activeIds).toEqual(["a", "b"]);
    (await jobs.gate("a")).finish("done");
    await jobs.gate("d");
    expect(jobs.order()).toEqual(["a", "b", "d"]);
    expect(queue.snapshot().activeIds).toEqual(["b", "d"]);
    (await jobs.gate("b")).finish("done");
    (await jobs.gate("d")).finish("done");
    await queue.whenSettled();
  });

  it("cancels every running item and every item still waiting", async () => {
    const jobs = controllable();
    const { queue, cancelJob } = harness(jobs.runJob, undefined, 2);
    cancelJob.mockImplementation(async (id) => {
      (await jobs.gate(id)).finish("cancel");
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    await jobs.gate("a");
    await jobs.gate("b");
    queue.cancelAll();
    await queue.whenSettled();
    expect(jobs.order()).toEqual(["a", "b"]);
    expect(cancelJob.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "b"]);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(queue.snapshot().phase).toBe("done");
    expect(queue.snapshot().activeIds).toEqual([]);
    expect(queue.isBusy()).toBe(false);
  });

  it("does not let a skipped or prepare-failed item keep a slot", async () => {
    const jobs = controllable();
    const { queue } = harness(
      jobs.runJob,
      async (item) => {
        if (item.id === "b") return { ok: false, status: "failed", message: MSG.noWrite };
        return { ok: true, probe: probe(item.id, item.id === "d" ? 10 : 80) };
      },
      2,
    );
    await queue.start([
      source("a", 80, 40),
      source("b", 80, 40),
      source("c", 80, 40),
      source("d", 10, 40),
      source("e", 80, 40),
    ]);
    await jobs.gate("a");
    await jobs.gate("c");
    expect(jobs.order()).toEqual(["a", "c"]);
    expect(queue.snapshot().items.find((item) => item.id === "b")?.status).toBe("failed");
    expect(queue.snapshot().items.find((item) => item.id === "b")?.message).toBe(MSG.noWrite);
    (await jobs.gate("a")).finish("done");
    await jobs.gate("e");
    expect(queue.snapshot().items.find((item) => item.id === "d")?.status).toBe("skipped");
    expect(queue.snapshot().activeIds).toEqual(["c", "e"]);
    (await jobs.gate("c")).finish("done");
    (await jobs.gate("e")).finish("done");
    await queue.whenSettled();
    expect(jobs.maxActive()).toBe(2);
    expect(queue.snapshot().items.map((item) => item.status)).toEqual([
      "success",
      "failed",
      "success",
      "skipped",
      "success",
    ]);
  });

  it("does not lower the batch cap when one running item falls back to software encode", async () => {
    let hardware = true;
    const jobs = controllable();
    const decideStart = vi.fn<() => Promise<StartDecision>>(async () => ({ action: "start" }));
    const concurrencyLimit = vi.fn(async () => (hardware ? 2 : 1));
    const queue = new BatchQueue({
      decideStart,
      concurrencyLimit,
      cancelJob: async () => undefined,
      prepare: async (item) => ({ ok: true, probe: probe(item.id, 80) }),
      runJob: async (item, info, hooks, output) => {
        if (item.id === "a") hardware = false;
        await jobs.runJob(item, info, hooks, output);
      },
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40), source("c", 80, 40)]);
    const first = await jobs.gate("a");
    const second = await jobs.gate("b");
    first.pulse({ ...progress(), encoder: "x265", percent: 22, elapsedSec: 5 });
    second.pulse({ ...progress(), encoder: "videotoolbox", percent: 48, elapsedSec: 6 });
    expect(hardware).toBe(false);
    expect(queue.snapshot().activeIds).toEqual(["a", "b"]);
    expect(queue.snapshot().items.find((item) => item.id === "b")?.status).toBe("running");
    expect(queue.snapshot().items.find((item) => item.id === "c")?.status).toBe("waiting");
    expect(queue.snapshot().items.find((item) => item.id === "a")?.progress?.encoder).toBe("x265");
    expect(queue.snapshot().items.find((item) => item.id === "b")?.progress?.encoder).toBe("videotoolbox");
    first.finish("done");
    await jobs.gate("c");
    expect(queue.snapshot().activeIds).toEqual(["b", "c"]);
    expect(jobs.maxActive()).toBe(2);
    expect(concurrencyLimit).toHaveBeenCalledTimes(1);
    expect(decideStart).toHaveBeenCalledTimes(1);
    second.finish("done");
    (await jobs.gate("c")).finish("done");
    await queue.whenSettled();
  });

  it("retries after the batch with the cap chosen at start, and does not decide the key again", async () => {
    let reported = 2;
    const jobs = controllable();
    const decideStart = vi.fn<() => Promise<StartDecision>>(async () => ({ action: "start" }));
    const concurrencyLimit = vi.fn(async () => reported);
    const queue = new BatchQueue({
      decideStart,
      concurrencyLimit,
      cancelJob: async () => undefined,
      prepare: async (item) => ({ ok: true, probe: probe(item.id, 80) }),
      runJob: jobs.runJob,
    });
    await queue.start([source("a", 80, 40), source("b", 80, 40)]);
    (await jobs.gate("a")).finish("fail");
    (await jobs.gate("b")).finish("fail");
    await queue.whenSettled();
    expect(jobs.maxActive()).toBe(2);
    reported = 1;
    jobs.resetPeak();
    queue.retryFailed();
    await jobs.gate("a");
    await jobs.gate("b");
    expect(queue.snapshot().activeIds).toEqual(["a", "b"]);
    expect(jobs.maxActive()).toBe(2);
    expect(concurrencyLimit).toHaveBeenCalledTimes(1);
    expect(decideStart).toHaveBeenCalledTimes(1);
    (await jobs.gate("a")).finish("done");
    (await jobs.gate("b")).finish("done");
    await queue.whenSettled();
    expect(queue.snapshot().items.map((item) => item.status)).toEqual(["success", "success"]);
  });

  it("passes the chosen folder and pattern into prepare and the job, including a retry", async () => {
    const seen: Array<{ where: string; directory: string | null; pattern: string | null }> = [];
    let failOnce = true;
    const { queue } = harness(async (_item, _probe, hooks, output) => {
      seen.push({ where: "job", directory: output.directory, pattern: output.pattern });
      if (failOnce) {
        failOnce = false;
        hooks.onFail({ message: "失败" });
        return;
      }
      hooks.onDone(done("a"));
    }, async (item) => {
      seen.push({ where: "prepare", directory: item.outputDirectory ?? null, pattern: null });
      return { ok: true, probe: probe(item.id, 80) };
    });
    await queue.start([source("a", 80, null)], { directory: "/out", pattern: "{originalStem}_a.mp4" });
    await queue.whenSettled();
    queue.retryItem("a");
    await queue.whenSettled();
    expect(seen.map((item) => item.directory)).toEqual(["/out", "/out", "/out", "/out"]);
    expect(seen.filter((item) => item.where === "job").every((item) => item.pattern === "{originalStem}_a.mp4")).toBe(true);
    expect(queue.snapshot().items[0]?.status).toBe("success");
  });

  it("uses the serial sentence when the displayed slot count is 1", () => {
    expect(queueConcurrencyLine(displayedQueueSlots(2, 1))).toBe(
      "这一次按顺序一支一支压。由这台设备自动决定，单个失败不影响其余。",
    );
    expect(queueConcurrencyLine(displayedQueueSlots(1, 3))).toBe(
      "这一次按顺序一支一支压。由这台设备自动决定，单个失败不影响其余。",
    );
    expect(queueConcurrencyLine(displayedQueueSlots(3, 1))).not.toContain("同时压");
    expect(queueConcurrencyLine(displayedQueueSlots(2, 0))).not.toContain("同时压 1");
  });
});
