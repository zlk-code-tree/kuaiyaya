import type { LicenseCode, LicenseErrorKind, LicenseState } from "./types";
import { messageForCode } from "./errors";

export function emptyLicenseState(): LicenseState {
  return {
    hasStoredKey: false,
    verified: false,
    silentChecking: false,
    pendingStart: false,
    lastCode: null,
    lastKind: null,
    expiresAt: null,
    banner: null,
  };
}

export function initialState(hasStoredKey: boolean): LicenseState {
  const s = emptyLicenseState();
  s.hasStoredKey = hasStoredKey;
  if (hasStoredKey) {
    s.silentChecking = true;
  }
  return s;
}

export function canCompress(s: LicenseState): boolean {
  return s.hasStoredKey && s.verified && s.lastKind === "ok";
}

export type StartDecision =
  | { action: "start" }
  | { action: "wait" }
  | { action: "block"; code: LicenseCode | "network"; message: string };

export function decideStart(s: LicenseState): StartDecision {
  if (s.verified && s.lastKind === "ok") {
    return { action: "start" };
  }
  if (s.hasStoredKey && s.silentChecking) {
    return { action: "wait" };
  }
  if (!s.hasStoredKey) {
    return { action: "block", code: "not_bound", message: "输入有效 Key 后才能开始压缩。不需要注册或登录。" };
  }
  const code = s.lastCode ?? "network";
  return { action: "block", code, message: messageForCode(code, "start") };
}

export function applySilentStart(s: LicenseState): LicenseState {
  return { ...s, silentChecking: true };
}

export function applyActivateStart(s: LicenseState): LicenseState {
  return { ...s, silentChecking: false, verified: false };
}

export function applySuccess(s: LicenseState, expiresAt: string | null): LicenseState {
  return {
    ...s,
    hasStoredKey: true,
    verified: true,
    silentChecking: false,
    pendingStart: false,
    lastCode: "ok",
    lastKind: "ok",
    expiresAt,
    banner: null,
  };
}

export function applyFailure(
  s: LicenseState,
  code: LicenseCode | "network",
  kind: LicenseErrorKind,
  showBanner: boolean,
): LicenseState {
  const banner = showBanner
    ? { text: messageForCode(code, "banner"), showReenter: kind === "key" }
    : null;
  return {
    ...s,
    verified: false,
    silentChecking: false,
    lastCode: code,
    lastKind: kind,
    banner,
  };
}

export function applyPendingStart(s: LicenseState, pending: boolean): LicenseState {
  return { ...s, pendingStart: pending };
}

export function applyClearKey(_s: LicenseState): LicenseState {
  return {
    ...emptyLicenseState(),
    hasStoredKey: false,
  };
}
