import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeInfo } from "../../shared/types";

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  probe: null as ProbeInfo | null,
  dialogResult: { canceled: false, filePaths: [] as string[] },
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocked.handlers.set(name, handler) },
  app: { getVersion: () => "test" },
  clipboard: { writeText: () => {} },
  dialog: { showOpenDialog: async () => mocked.dialogResult },
  shell: {},
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

describe("output settings IPC", () => {
  let dir = "";
  let path = "";
  let runJob: ReturnType<typeof vi.fn>;
  let startQueue: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mocked.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-output-ipc-"));
    path = join(dir, "source.mp4");
    await writeFile(path, Buffer.alloc(5 * 1024 * 1024));
    mocked.probe = {
      path, name: "source.mp4", sizeBytes: 5 * 1024 * 1024, durationSec: 30,
      width: 1280, height: 720, rotation: 0, displayWidth: 1280, displayHeight: 720,
      videoCodec: "h264", hasAudio: false, container: "mp4",
    };
    runJob = vi.fn(async () => undefined);
    startQueue = vi.fn(async () => ({ ok: true }));
    const ctx = {
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
      session: { decideStart: async () => ({ action: "start" }) },
      job: { isRunning: false, run: runJob, cancel: async () => {} },
      analyzer: { isRunning: false, run: async () => { throw new Error("unused"); }, cancel: async () => {} },
      getFfmpeg: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
      getCaps: async () => ({ x265: true, videotoolbox: false }),
      queue: { isBusy: () => false, start: startQueue },
      preview: { noteSuccess: () => {}, revoke: () => {}, acquire: async () => null },
    } as unknown as MainContext;
    registerIpc(ctx);
    await invoke("probe", path);
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("forwards a chosen folder and pattern, and rejects a pattern that leaves the folder", async () => {
    const out = join(dir, "out");
    await mkdir(out);
    await invoke("start-compress", { filePath: path, targetMB: null, output: { directory: out, pattern: "{originalStem}_mail.mp4" } });
    expect(runJob).toHaveBeenCalledWith(expect.objectContaining({
      targetMB: null,
      output: { directory: out, pattern: "{originalStem}_mail.mp4" },
    }));
    await expect(invoke("start-compress", {
      filePath: path,
      targetMB: 1,
      output: { directory: out, pattern: "../escape.mp4" },
    })).rejects.toThrow("文件名不能包含文件夹");
    expect(runJob).toHaveBeenCalledTimes(1);

    const queued = await invoke<{ ok: boolean; message?: string }>("queue-start", {
      items: [{ id: "a", filePath: path, name: "source.mp4", targetMB: null, sizeBytes: 1, durationSec: 1, displayWidth: 1, displayHeight: 1 }],
      output: { directory: "relative", pattern: "{originalStem}.mp4" },
    });
    expect(queued.ok).toBe(false);
    expect(queued.message).toBe("所选文件夹无效。");
    expect(startQueue).not.toHaveBeenCalled();
  });

  it("returns the folder picked in the dialog", async () => {
    mocked.dialogResult = { canceled: false, filePaths: [join(dir, "picked")] };
    expect(await invoke("select-output-directory")).toBe(join(dir, "picked"));
    mocked.dialogResult = { canceled: true, filePaths: [] };
    expect(await invoke("select-output-directory")).toBeNull();
  });
});
