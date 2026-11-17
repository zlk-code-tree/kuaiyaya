import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProbeInfo } from "../../shared/types";
import { OUTPUT_PREVIEW_URL } from "../../shared/preview-url";

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => mocked.handlers.set(name, handler),
  },
  app: { getVersion: () => "test" },
  clipboard: { writeText: () => {} },
  dialog: {},
  shell: {},
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {},
  },
}));
vi.mock("../ffmpeg/probe", () => ({
  probeFile: async () => mockedProbe,
  isLikelyVideoPath: () => true,
}));

import { handleMediaRequest, OutputPreviewGate } from "../media-protocol";
import { registerIpc, type MainContext } from "../ipc";

let mockedProbe: ProbeInfo | null = null;

function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const handler = mocked.handlers.get(name);
  if (!handler) throw new Error(`missing IPC handler: ${name}`);
  return Promise.resolve(handler({}, ...args) as T);
}

describe("output preview IPC", () => {
  let dir = "";
  let source = "";
  let output = "";
  let gate: OutputPreviewGate;
  let runJob: ReturnType<typeof vi.fn>;
  let startQueue: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mocked.handlers.clear();
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-preview-ipc-"));
    source = join(dir, "source.mp4");
    output = join(dir, "source_compressed.mp4");
    await writeFile(source, Buffer.alloc(5 * 1024 * 1024));
    await writeFile(output, Buffer.from("0123456789"));
    mockedProbe = {
      path: source, name: "source.mp4", sizeBytes: 5 * 1024 * 1024, durationSec: 30,
      width: 640, height: 360, rotation: 0, displayWidth: 640, displayHeight: 360,
      videoCodec: "h264", hasAudio: false, container: "mp4",
    };
    gate = new OutputPreviewGate();
    runJob = vi.fn(async () => undefined);
    startQueue = vi.fn(async () => ({ ok: true }));
    const ctx = {
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: () => {} } }),
      session: { decideStart: async () => ({ action: "start" }) },
      job: { isRunning: false, run: runJob, cancel: async () => {} },
      analyzer: { isRunning: false, run: async () => undefined, cancel: async () => {} },
      getFfmpeg: async () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
      getCaps: async () => ({ x265: true, videotoolbox: true }),
      queue: { isBusy: () => false, start: startQueue, retryFailed: () => {}, retryItem: () => {} },
      preview: gate,
    } as unknown as MainContext;
    registerIpc(ctx);
    await invoke("probe", source);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("issues a URL only for the successful output that is still on disk", async () => {
    expect(await invoke("acquire-output-preview", output)).toBeNull();
    expect(await invoke("acquire-output-preview", source)).toBeNull();

    gate.noteSuccess(output);
    expect(await invoke("acquire-output-preview", source)).toBeNull();
    expect(await invoke("acquire-output-preview", output)).toBe(OUTPUT_PREVIEW_URL);

    const response = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=0-3" },
    }));
    expect(response.status).toBe(206);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("0123");
  });

  it("does not issue a URL when the finished file has been removed", async () => {
    const missing = join(dir, "moved.mp4");
    gate.noteSuccess(missing);
    expect(await invoke("acquire-output-preview", missing)).toBeNull();
    const response = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(response.status).toBe(403);
  });

  it("revokes the preview when another single-file or batch job starts", async () => {
    gate.noteSuccess(output);
    expect(await invoke("acquire-output-preview", output)).toBe(OUTPUT_PREVIEW_URL);

    await invoke("start-compress", { filePath: source, targetMB: 1 });
    expect(runJob).toHaveBeenCalledTimes(1);
    const afterSingle = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(afterSingle.status).toBe(403);

    gate.noteSuccess(output);
    expect(await gate.acquire(output)).toBe(OUTPUT_PREVIEW_URL);
    await invoke("queue-start", {
      items: [{ id: "a", filePath: source, name: "source.mp4", targetMB: 1, sizeBytes: 1, durationSec: 1, displayWidth: 1, displayHeight: 1 }],
    });
    expect(startQueue).toHaveBeenCalledTimes(1);
    const afterQueue = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(afterQueue.status).toBe(403);

    gate.noteSuccess(output);
    expect(await gate.acquire(output)).toBe(OUTPUT_PREVIEW_URL);
    await invoke("queue-retry", { id: "a" });
    const afterRetry = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(afterRetry.status).toBe(403);
    expect(await invoke("acquire-output-preview", output)).toBeNull();
  });

  it("stops serving the file after the renderer releases the preview", async () => {
    gate.noteSuccess(output);
    expect(await invoke("acquire-output-preview", output)).toBe(OUTPUT_PREVIEW_URL);
    await invoke("release-output-preview");
    const response = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=0-9" },
    }));
    expect(response.status).toBe(403);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("");
  });
});
