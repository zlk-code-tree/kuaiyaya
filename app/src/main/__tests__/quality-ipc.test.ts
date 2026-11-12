import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeInfo, QualityAnalysis } from "../../shared/types";

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  probe: null as ProbeInfo | null,
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocked.handlers.set(name, handler) },
  app: { getVersion: () => "test" }, clipboard: { writeText: () => {} }, dialog: {}, shell: {},
}));
vi.mock("../ffmpeg/probe", () => ({
  probeFile: async () => mocked.probe,
  isLikelyVideoPath: () => true,
}));
import { registerIpc, type MainContext } from "../ipc";

function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = mocked.handlers.get(name);
  if (!handler) throw new Error(`missing IPC handler: ${name}`);
  return Promise.resolve(handler({}, ...args) as T);
}

describe("quality analysis IPC", () => {
  let dir = "";
  let path = "";
  let result: QualityAnalysis;
  let runJob: ReturnType<typeof vi.fn>;
  let runAnalysis: ReturnType<typeof vi.fn>;
  let decideStart: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mocked.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-ipc-"));
    path = join(dir, "source.mp4");
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024));
    mocked.probe = {
      path, name: "source.mp4", sizeBytes: 5 * 1024 * 1024, durationSec: 30,
      width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360,
      videoCodec: "h264", hasAudio: false, container: "mp4",
    };
    result = {
      filePath: path, encoder: "x265", metric: "ssim", sampleCount: 3, sampleDurationSec: 9,
      candidates: [{ targetMB: 1, estimatedMB: 1, lowestScore: 0.95, averageScore: 0.96 },
        { targetMB: 3, estimatedMB: 3, lowestScore: 0.98, averageScore: 0.98 }],
      recommendedTargetMB: 3, meetsHeuristic: true,
    };
    runJob = vi.fn(async () => undefined);
    runAnalysis = vi.fn(async () => result);
    decideStart = vi.fn(async () => ({ action: "start" }));
    const ctx = {
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
      session: { decideStart },
      job: { isRunning: false, run: runJob, cancel: async () => {} },
      analyzer: { isRunning: false, run: runAnalysis, cancel: async () => {} },
      getFfmpeg: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
      getCaps: async () => ({ x265: true, videotoolbox: true }),
    } as unknown as MainContext;
    registerIpc(ctx);
    await invoke("probe", path);
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("uses the measured encoder for either analyzed target and rejects a changed source", async () => {
    await invoke("analyze-quality", { filePath: path, targetMB: 1 });
    await invoke("start-compress", { filePath: path, targetMB: 3 });
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({ targetMB: 3, preferredEncoder: "x265" }));
    await appendFile(path, "changed");
    await expect(invoke("start-compress", { filePath: path, targetMB: 1 })).rejects.toThrow("文件已发生变化");
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation while license validation is still pending", async () => {
    let release!: () => void;
    decideStart.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ action: "start" }); }));
    const work = invoke("analyze-quality", { filePath: path, targetMB: 1 });
    const observed = work.then(() => "success", (err: Error) => err.message);
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    await invoke("cancel-analysis");
    release();
    expect(await observed).toContain("已取消");
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});
