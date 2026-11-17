import { describe, expect, it, vi } from "vitest";
import { compareVersions, UpdateChecker } from "../checker";

const release = { platform: "darwin", arch: "arm64", version: "1.0.10", notes: "画质改进", downloadUrl: "https://downloads.example.com/app.dmg" };
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const checker = (fetchImpl: typeof fetch, base = "http://127.0.0.1:8080", opener = vi.fn(async (_url: string) => undefined)) =>
  new UpdateChecker(() => base, "1.0.2", "darwin", "arm64", opener, fetchImpl);

describe("version comparisons", () => {
  it("compares version components numerically and rejects malformed versions", () => {
    expect(compareVersions("1.0.10", "1.0.2")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
    expect(compareVersions("1.0.2-beta", "1.0.2")).toBeNull();
    expect(compareVersions("1.0.02", "1.0.2")).toBeNull();
  });
});

describe("update checker", () => {
  it("checks the correct platform and opens only the checked HTTPS download", async () => {
    const fetcher = vi.fn(async () => response({ ok: true, data: release })) as unknown as typeof fetch;
    const open = vi.fn(async (_url: string) => undefined);
    const service = checker(fetcher, "http://127.0.0.1:8080", open);
    await expect(service.openDownload()).rejects.toThrow();
    expect(await service.check()).toEqual({ status: "available", version: "1.0.10", notes: "画质改进" });
    const request = vi.mocked(fetcher).mock.calls[0][0] as URL;
    expect(request.pathname).toBe("/v1/app/releases/latest");
    expect(request.searchParams.get("platform")).toBe("darwin");
    expect(request.searchParams.get("arch")).toBe("arm64");
    await service.openDownload();
    expect(open).toHaveBeenCalledWith(release.downloadUrl);
  });

  it("distinguishes no publication, an up-to-date version, and errors", async () => {
    expect(await checker(vi.fn(async () => response({ ok: true, data: null }))).check()).toEqual({ status: "not-published" });
    expect(await checker(vi.fn(async () => response({ ok: true, data: { ...release, version: "1.0.2" } }))).check()).toEqual({ status: "up-to-date" });
    expect(await checker(vi.fn(async () => { throw new Error("offline"); })).check()).toEqual({ status: "error" });
    expect(await checker(vi.fn(async () => response({}, 503))).check()).toEqual({ status: "error" });
  });

  it("rejects untrusted addresses, wrong platform, oversized or malformed release data", async () => {
    for (const bad of [
      { ...release, downloadUrl: "http://example.com/a" },
      { ...release, downloadUrl: "https://user:pass@example.com/a" },
      { ...release, platform: "win32" },
      { ...release, version: "1.2.3-beta" },
      { ...release, notes: "x".repeat(2001) },
    ]) {
      const service = checker(vi.fn(async () => response({ ok: true, data: bad })));
      expect(await service.check()).toEqual({ status: "error" });
      await expect(service.openDownload()).rejects.toThrow();
    }
    const fetcher = vi.fn(async () => response({ ok: true, data: release }));
    expect(await checker(fetcher, "http://remote.example.com").check()).toEqual({ status: "error" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await checker(vi.fn(async () => new Response("x".repeat(65_537)))).check()).toEqual({ status: "error" });
  });

  it("shares simultaneous checks and does not fetch on unsupported platforms", async () => {
    const fetcher = vi.fn(async () => response({ ok: true, data: release }));
    const service = checker(fetcher);
    const [first, second] = await Promise.all([service.check(), service.check()]);
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const unsupported = new UpdateChecker(() => "http://127.0.0.1:8080", "1.0.2", "linux", "x64", vi.fn(), fetcher);
    expect(await unsupported.check()).toEqual({ status: "unsupported" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
