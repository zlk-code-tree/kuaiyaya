import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTPUT_PREVIEW_URL } from "../../shared/preview-url";

const protocol = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
}));
vi.mock("electron", () => ({ protocol }));

import {
  handleMediaRequest,
  installMediaHandler,
  isCanonicalPreviewRequest,
  MEDIA_SCHEME_PRIVILEGES,
  OutputPreviewGate,
  registerMediaScheme,
} from "../media-protocol";

describe("output preview protocol", () => {
  let dir = "";
  let output = "";
  let other = "";
  let gate: OutputPreviewGate;

  beforeEach(async () => {
    protocol.registerSchemesAsPrivileged.mockClear();
    protocol.handle.mockClear();
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-media-"));
    output = join(dir, "done.mp4");
    other = join(dir, "other.mp4");
    await writeFile(output, Buffer.from("0123456789"));
    await writeFile(other, Buffer.from("ABCDEFGHIJ"));
    gate = new OutputPreviewGate();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function body(response: Response): Promise<string> {
    return new TextDecoder().decode(await response.arrayBuffer());
  }

  it("rejects an unregistered preview and any URL that is not the fixed preview address", async () => {
    const unregistered = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(unregistered.status).toBe(403);
    expect(await body(unregistered)).toBe("");

    gate.noteSuccess(output);
    expect(await gate.acquire(other)).toBeNull();
    expect(await gate.acquire(output)).toBe(OUTPUT_PREVIEW_URL);

    const rejected = [
      `kuaiyaya-media://preview/${encodeURIComponent(other)}`,
      "kuaiyaya-media://preview/secrets",
      "kuaiyaya-media://files/output",
      `kuaiyaya-media://preview/output?path=${encodeURIComponent(other)}`,
      "kuaiyaya-media://preview:443/output",
      "kuaiyaya-media://Preview/output",
    ];
    expect(isCanonicalPreviewRequest("kuaiyaya-media://user@preview/output")).toBe(false);
    for (const url of rejected) {
      const response = await handleMediaRequest(gate, new Request(url));
      expect(response.status, url).toBe(403);
      const text = await body(response);
      expect(text, url).not.toContain("ABCDE");
      expect(text, url).not.toContain("0123");
    }
  });

  it("returns 206 with Content-Range for a byte range and 200 for a full read", async () => {
    gate.noteSuccess(output);
    expect(await gate.acquire(output)).toBe(OUTPUT_PREVIEW_URL);

    const ranged = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=2-5" },
    }));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(ranged.headers.get("content-length")).toBe("4");
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(await body(ranged)).toBe("2345");

    const openEnded = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=8-" },
    }));
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await body(openEnded)).toBe("89");

    const whole = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("content-length")).toBe("10");
    expect(await body(whole)).toBe("0123456789");

    const unsatisfiable = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=20-30" },
    }));
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  it("cannot read the file after the registration is revoked", async () => {
    gate.noteSuccess(output);
    expect(await gate.acquire(output)).toBe(OUTPUT_PREVIEW_URL);
    gate.revoke();

    const response = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL, {
      headers: { Range: "bytes=0-3" },
    }));
    expect(response.status).toBe(403);
    expect(await body(response)).toBe("");
    expect(await gate.acquire(output)).toBeNull();
  });

  it("does not issue a URL when the output file is missing", async () => {
    const missing = join(dir, "gone.mp4");
    gate.noteSuccess(missing);
    expect(await gate.acquire(missing)).toBeNull();

    const response = await handleMediaRequest(gate, new Request(OUTPUT_PREVIEW_URL));
    expect(response.status).toBe(403);
    expect(await body(response)).toBe("");
  });

  it("does not register a file when revoke wins the access check", async () => {
    let releaseCheck!: () => void;
    const slow = new OutputPreviewGate(() => new Promise((resolve) => {
      releaseCheck = () => resolve();
    }));
    slow.noteSuccess(output);
    const pending = slow.acquire(output);
    slow.revoke();
    releaseCheck();
    await expect(pending).resolves.toBeNull();
    const response = await handleMediaRequest(slow, new Request(OUTPUT_PREVIEW_URL));
    expect(response.status).toBe(403);
  });

  it("registers the scheme before any window exists and does not bypass CSP", () => {
    registerMediaScheme();
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: "kuaiyaya-media", privileges: { ...MEDIA_SCHEME_PRIVILEGES } },
    ]);
    const privileges = protocol.registerSchemesAsPrivileged.mock.calls[0]?.[0]?.[0]?.privileges as Record<string, boolean>;
    expect(privileges.bypassCSP).toBeUndefined();
    expect(privileges).toMatchObject({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    });

    installMediaHandler(gate);
    expect(protocol.handle).toHaveBeenCalledWith("kuaiyaya-media", expect.any(Function));
  });
});
