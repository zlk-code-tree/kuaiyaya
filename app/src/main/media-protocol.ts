import { protocol } from "electron";
import { createReadStream, type ReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { MEDIA_SCHEME, OUTPUT_PREVIEW_URL } from "../shared/preview-url";

/**
 * Privileges required for `<video>` to load the scheme.
 * `bypassCSP` is intentionally omitted.
 */
export const MEDIA_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true,
} as const;

const PREVIEW_HOST = "preview";
const PREVIEW_PATH = "/output";

async function defaultCanRead(filePath: string): Promise<void> {
  await access(filePath);
}

/**
 * Allows exactly one Done-page output to be read, and only through the fixed preview URL.
 * The filesystem path is never taken from the request URL.
 */
export class OutputPreviewGate {
  private generation = 0;
  private candidate: string | null = null;
  private allowed: string | null = null;

  constructor(private readonly canRead: (filePath: string) => Promise<void> = defaultCanRead) {}

  /** Remember the output of a successful single-file compress. Does not open the file. */
  noteSuccess(outputPath: string): void {
    if (typeof outputPath !== "string" || outputPath.length === 0) return;
    this.candidate = outputPath;
    if (this.allowed !== outputPath) this.allowed = null;
  }

  /**
   * Issue the preview URL when `outputPath` is the current success and still on disk.
   * A revoke that lands while the access check is in flight does not register the file.
   */
  async acquire(outputPath: string): Promise<string | null> {
    const generation = this.generation;
    if (typeof outputPath !== "string" || outputPath.length === 0 || outputPath !== this.candidate) {
      return null;
    }
    try {
      await this.canRead(outputPath);
    } catch {
      this.allowed = null;
      return null;
    }
    if (generation !== this.generation || outputPath !== this.candidate) return null;
    this.allowed = outputPath;
    return OUTPUT_PREVIEW_URL;
  }

  /** Drop the registration so the finished file can be deleted or overwritten. */
  revoke(): void {
    this.generation += 1;
    this.candidate = null;
    this.allowed = null;
  }

  fileForRequest(rawUrl: string): string | null {
    if (!this.allowed) return null;
    if (!isCanonicalPreviewRequest(rawUrl)) return null;
    return this.allowed;
  }
}

export function isCanonicalPreviewRequest(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === `${MEDIA_SCHEME}:`
    && url.hostname === PREVIEW_HOST
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.pathname === PREVIEW_PATH
    && url.search === ""
    && url.hash === "";
}

export function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || size <= 0) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { start: size - length, end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isInteger(start) || start < 0 || start >= size) return null;
  const end = endText === "" ? size - 1 : Number(endText);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { ...MEDIA_SCHEME_PRIVILEGES } },
  ]);
}

export function installMediaHandler(gate: OutputPreviewGate): void {
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(gate, request));
}

export async function handleMediaRequest(gate: OutputPreviewGate, request: Request): Promise<Response> {
  try {
    return await respondToMedia(gate, request);
  } catch {
    return new Response(null, { status: 500 });
  }
}

async function respondToMedia(gate: OutputPreviewGate, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const filePath = gate.fileForRequest(request.url);
  if (!filePath) return new Response(null, { status: 403 });

  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return new Response(null, { status: 404 });
  const size = info.size;
  const rangeHeader = request.headers.get("range");
  if (rangeHeader == null || rangeHeader.trim() === "") {
    if (size === 0) return mediaResponse(request, filePath, { status: 200, start: 0, end: 0, size, length: 0 });
    return mediaResponse(request, filePath, { status: 200, start: 0, end: size - 1, size, length: size });
  }
  const range = parseByteRange(rangeHeader, size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: mediaHeaders(0, `bytes */${size}`),
    });
  }
  const length = range.end - range.start + 1;
  return mediaResponse(request, filePath, {
    status: 206,
    start: range.start,
    end: range.end,
    size,
    length,
  });
}

function mediaHeaders(length: number, contentRange?: string): Headers {
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(length),
  });
  if (contentRange) headers.set("Content-Range", contentRange);
  return headers;
}

function mediaResponse(
  request: Request,
  filePath: string,
  slice: { status: 200 | 206; start: number; end: number; size: number; length: number },
): Response {
  const contentRange = slice.status === 206 ? `bytes ${slice.start}-${slice.end}/${slice.size}` : undefined;
  const headers = mediaHeaders(slice.length, contentRange);
  if (request.method === "HEAD" || slice.length === 0) {
    return new Response(null, { status: slice.status, headers });
  }
  return new Response(streamFile(filePath, slice.start, slice.end, request.signal), {
    status: slice.status,
    headers,
  });
}

function streamFile(filePath: string, start: number, end: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const node: ReadStream = createReadStream(filePath, { start, end });
  const abort = () => {
    node.destroy();
  };
  if (signal.aborted) abort();
  else {
    signal.addEventListener("abort", abort, { once: true });
    node.once("close", () => signal.removeEventListener("abort", abort));
  }
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}
