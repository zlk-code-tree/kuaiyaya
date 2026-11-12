import { describe, expect, it, vi } from "vitest";
import { postLicense } from "../client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("license client", () => {
  it("maps a successful validate body without bind_token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, data: { expiresAt: null, serverTime: "2026-11-12T04:00:00.000Z" } }),
    );
    const result = await postLicense(
      { baseUrl: "http://127.0.0.1:8080", fetchImpl: fetchImpl as unknown as typeof fetch },
      "/v1/license/validate",
      { key: "KYDY-AAAA-BBBB-CCCC", deviceId: "a".repeat(64) },
    );
    expect(result.ok).toBe(true);
    expect(result.expiresAt).toBeNull();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(call[1].body));
    expect(sent.key).toBeDefined();
    expect(sent.deviceId).toBeDefined();
    expect(sent.bind_token).toBeUndefined();
  });

  it("classifies 5xx as network, not a key error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(502, { ok: false }));
    const result = await postLicense(
      { baseUrl: "http://example.test", fetchImpl: fetchImpl as unknown as typeof fetch },
      "/v1/license/activate",
      { key: "X", deviceId: "a".repeat(64) },
    );
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("network");
    expect(result.message).toMatch(/网络不通/);
    expect(result.message).not.toMatch(/无效或过期/);
  });

  it("keeps not_bound as a key problem", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { ok: false, error: { code: "not_bound", message: "dev" } }),
    );
    const result = await postLicense(
      { baseUrl: "http://example.test", fetchImpl: fetchImpl as unknown as typeof fetch },
      "/v1/license/validate",
      { key: "KYDY-AAAA-BBBB-CCCC", deviceId: "a".repeat(64) },
    );
    expect(result.kind).toBe("key");
    expect(result.code).toBe("not_bound");
    expect(result.message).not.toMatch(/网络不通/);
  });

  it("treats a thrown connection error as network", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("fetch failed");
      (err as Error & { code: string }).code = "ECONNREFUSED";
      throw err;
    });
    const result = await postLicense(
      { baseUrl: "http://127.0.0.1:1", fetchImpl: fetchImpl as unknown as typeof fetch },
      "/v1/license/validate",
      { key: "KYDY-AAAA-BBBB-CCCC", deviceId: "a".repeat(64) },
    );
    expect(result.kind).toBe("network");
  });
});
