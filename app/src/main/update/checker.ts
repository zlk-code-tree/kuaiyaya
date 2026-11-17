import type { UpdateCheckResult } from "../../shared/types";

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function compareVersions(a: string, b: string): number | null {
  if (!VERSION.test(a) || !VERSION.test(b)) return null;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function endpoint(baseUrl: string, platform: string, arch: string): URL {
  const base = new URL(baseUrl);
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && isLocal)) || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid service URL");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1/app/releases/latest`;
  base.searchParams.set("platform", platform);
  base.searchParams.set("arch", arch);
  return base;
}

function httpsDownload(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048 || /[\r\n\t]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function limitedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES || !res.body) throw new Error("invalid response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response too large");
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class UpdateChecker {
  private pending: Promise<UpdateCheckResult> | null = null;
  private downloadUrl: string | null = null;

  constructor(
    private readonly apiBase: () => string,
    private readonly currentVersion: string,
    private readonly platform: string,
    private readonly arch: string,
    private readonly open: (url: string) => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  check(): Promise<UpdateCheckResult> {
    if (!this.pending) {
      this.pending = this.checkOnce().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async openDownload(): Promise<void> {
    if (!this.downloadUrl) throw new Error("请先检查更新。");
    await this.open(this.downloadUrl);
  }

  private async checkOnce(): Promise<UpdateCheckResult> {
    if (!((this.platform === "darwin" && this.arch === "arm64") || (this.platform === "win32" && this.arch === "x64"))) {
      return { status: "unsupported" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const url = endpoint(this.apiBase(), this.platform, this.arch);
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: controller.signal, redirect: "error",
      });
      if (!response.ok) throw new Error("update endpoint unavailable");
      const body = JSON.parse(await limitedText(response)) as { ok?: unknown; data?: unknown };
      if (!body || body.ok !== true || !("data" in body)) throw new Error("invalid update response");
      if (body.data === null) {
        this.downloadUrl = null;
        return { status: "not-published" };
      }
      if (typeof body.data !== "object") throw new Error("invalid release");
      const data = body.data as Record<string, unknown>;
      if (data.platform !== this.platform || data.arch !== this.arch || typeof data.version !== "string" || typeof data.notes !== "string" || data.notes.length > 2000) throw new Error("invalid release");
      const comparison = compareVersions(data.version, this.currentVersion);
      const downloadUrl = httpsDownload(data.downloadUrl);
      if (comparison === null || !downloadUrl) throw new Error("invalid release");
      if (comparison <= 0) {
        this.downloadUrl = null;
        return { status: "up-to-date" };
      }
      this.downloadUrl = downloadUrl;
      return { status: "available", version: data.version, notes: data.notes };
    } catch {
      return { status: "error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
