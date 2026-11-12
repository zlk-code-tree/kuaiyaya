import { describe, expect, it } from "vitest";
import {
  classifyHttpStatus,
  classifyLicenseResponse,
  classifyTransportError,
  messageForCode,
} from "../errors";

describe("error classification", () => {
  it("treats timeouts, TLS and connection errors as network", () => {
    expect(classifyTransportError({ name: "AbortError" })).toBe(true);
    expect(classifyTransportError({ code: "ECONNREFUSED" })).toBe(true);
    expect(classifyTransportError({ code: "ETIMEDOUT" })).toBe(true);
    expect(classifyTransportError({ message: "unable to verify the first certificate" })).toBe(true);
    expect(classifyTransportError({ cause: { code: "ENOTFOUND" } })).toBe(true);
  });

  it("treats 5xx and 429 as network, never as a key problem", () => {
    expect(classifyHttpStatus(500)).toBe("network");
    expect(classifyHttpStatus(502)).toBe("network");
    expect(classifyHttpStatus(429)).toBe("network");
    expect(classifyHttpStatus(403)).toBe("other");
    const r = classifyLicenseResponse({ status: 503 });
    expect(r.kind).toBe("network");
    expect(r.code).toBe("network");
    expect(r.message).not.toMatch(/无效或过期/);
  });

  it("does not merge business codes", () => {
    for (const code of [
      "invalid",
      "expired",
      "device_bound_to_other_key",
      "key_bound_to_other_device",
      "not_bound",
      "invalid_request",
    ] as const) {
      const r = classifyLicenseResponse({ status: 403, code });
      expect(r.code).toBe(code);
      expect(r.kind).not.toBe("network");
    }
    expect(classifyLicenseResponse({ status: 403, code: "expired" }).message).toMatch(/无效或已过期/);
    expect(classifyLicenseResponse({ status: 409, code: "not_bound" }).message).toMatch(/绑定已解除/);
    expect(classifyLicenseResponse({ status: 409, code: "not_bound" }).message).not.toMatch(/网络不通/);
  });

  it("maps transport failures independently of a leftover key code", () => {
    const r = classifyLicenseResponse({ transportError: { code: "ECONNREFUSED" }, code: "invalid" });
    expect(r.kind).toBe("network");
    expect(r.code).toBe("network");
  });

  it("keeps start-dialog copy distinct for network vs key", () => {
    expect(messageForCode("network", "start")).toMatch(/不是 Key 无效或过期/);
    expect(messageForCode("expired", "start")).toMatch(/无效或已过期/);
    expect(messageForCode("network", "banner")).toMatch(/仍可查看或打开已有文件/);
  });
});
