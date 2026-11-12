import type { LicenseCode, LicenseErrorKind } from "./types";
import { MSG } from "./messages";

export function classifyTransportError(err: unknown): boolean {
  if (!err || typeof err !== "object") return true;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  const msg = (e.message ?? "").toLowerCase();
  const name = e.name ?? "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
    ].includes(code)
  ) {
    return true;
  }
  if (
    msg.includes("timeout") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("certificate") ||
    msg.includes("ssl") ||
    msg.includes("tls") ||
    msg.includes("econnrefused")
  ) {
    return true;
  }
  return false;
}

export function classifyHttpStatus(status: number): "network" | "ok" | "other" {
  if (status === 429 || status >= 500) return "network";
  return "other";
}

export interface ClassifiedLicense {
  ok: boolean;
  code: LicenseCode | "network";
  kind: LicenseErrorKind | "ok";
  message: string;
}

const KEY_CODES: LicenseCode[] = [
  "invalid",
  "expired",
  "device_bound_to_other_key",
  "key_bound_to_other_device",
  "not_bound",
  "invalid_request",
];

export function messageForCode(code: LicenseCode | "network", context: "inline" | "start" | "banner"): string {
  if (code === "network") {
    if (context === "start") return MSG.networkStart;
    if (context === "banner") return MSG.networkBanner;
    return MSG.network;
  }
  if (code === "invalid" || code === "expired") {
    if (context === "start") return MSG.invalidOrExpiredStart;
    if (context === "banner") return MSG.expiredBanner;
    return MSG.invalidOrExpired;
  }
  if (code === "device_bound_to_other_key") return MSG.deviceBoundToOtherKey;
  if (code === "key_bound_to_other_device") return MSG.keyBoundToOtherDevice;
  if (code === "not_bound") {
    return context === "banner" ? MSG.notBoundBanner : MSG.notBound;
  }
  return MSG.invalidRequest;
}

export function classifyLicenseResponse(input: {
  ok?: boolean;
  status?: number;
  code?: string;
  transportError?: unknown;
}): ClassifiedLicense {
  if (input.transportError) {
    return { ok: false, code: "network", kind: "network", message: messageForCode("network", "inline") };
  }
  if (input.status != null && classifyHttpStatus(input.status) === "network") {
    return { ok: false, code: "network", kind: "network", message: messageForCode("network", "inline") };
  }
  if (input.ok || input.code === "ok") {
    return { ok: true, code: "ok", kind: "ok", message: MSG.activated };
  }
  const raw = input.code ?? "";
  if ((KEY_CODES as string[]).includes(raw)) {
    const code = raw as LicenseCode;
    const kind: LicenseErrorKind = code === "invalid_request" ? "invalid_request" : "key";
    return { ok: false, code, kind, message: messageForCode(code, "inline") };
  }
  if (input.status != null && input.status >= 400 && input.status < 500) {
    return { ok: false, code: "invalid_request", kind: "invalid_request", message: MSG.invalidRequest };
  }
  return { ok: false, code: "network", kind: "network", message: messageForCode("network", "inline") };
}
