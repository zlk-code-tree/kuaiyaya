import { classifyLicenseResponse, classifyTransportError } from "../../shared/errors";
import { API_TIMEOUT_MS } from "../../shared/messages";
import type { LicenseResult } from "../../shared/types";
import { Normalize } from "./normalize";

export interface ApiConfig {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  appVersion?: string;
}

interface ServerBody {
  ok?: boolean;
  data?: { expiresAt?: string | null; serverTime?: string };
  error?: { code?: string; message?: string };
}

export async function postLicense(
  cfg: ApiConfig,
  path: "/v1/license/activate" | "/v1/license/validate",
  body: Record<string, unknown>,
): Promise<LicenseResult> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? API_TIMEOUT_MS);
  try {
    const fetchImpl = cfg.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: ServerBody = {};
    try {
      parsed = (await res.json()) as ServerBody;
    } catch {
      parsed = {};
    }
    const classified = classifyLicenseResponse({
      ok: parsed.ok === true,
      status: res.status,
      code: parsed.error?.code ?? (parsed.ok ? "ok" : undefined),
    });
    return {
      ok: classified.ok,
      code: classified.code,
      kind: classified.kind === "ok" ? undefined : classified.kind,
      message: classified.message,
      expiresAt: parsed.data?.expiresAt ?? null,
    };
  } catch (err) {
    const network = classifyTransportError(err) || true;
    const classified = classifyLicenseResponse({ transportError: network ? err : err });
    return {
      ok: false,
      code: classified.code,
      kind: classified.kind === "ok" ? undefined : classified.kind,
      message: classified.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function activatePayload(key: string, deviceId: string, appVersion: string, label: string) {
  return {
    key: Normalize(key),
    deviceId,
    appVersion,
    platform: process.platform,
    arch: process.arch,
    deviceLabel: label,
  };
}

export function validatePayload(key: string, deviceId: string, appVersion: string) {
  return {
    key: Normalize(key),
    deviceId,
    appVersion,
  };
}
