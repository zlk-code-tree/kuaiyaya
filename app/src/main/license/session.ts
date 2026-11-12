import type { LicenseResult, LicenseState } from "../../shared/types";
import {
  applyActivateStart,
  applyFailure,
  applyPendingStart,
  applySuccess,
  decideStart,
  initialState,
  type StartDecision,
} from "../../shared/license-machine";
import { Normalize } from "./normalize";
import { clearStoredKey, readStoredKey, writeStoredKey, type SecretStore } from "./store";
import { currentDeviceId, deviceLabel } from "./device";
import { activatePayload, postLicense, validatePayload, type ApiConfig } from "./client";

export type DeviceIdFn = () => Promise<string>;

export class LicenseSession {
  private state: LicenseState = initialState(false);
  private listeners = new Set<(s: LicenseState) => void>();
  private inflight: Promise<LicenseResult> | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly api: () => ApiConfig,
    private readonly appVersion: string,
    private readonly deviceIdFn: DeviceIdFn = currentDeviceId,
    private readonly labelFn: () => string = deviceLabel,
  ) {}

  onChange(cb: (s: LicenseState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getState(): LicenseState {
    return { ...this.state, banner: this.state.banner ? { ...this.state.banner } : null };
  }

  private set(s: LicenseState): void {
    this.state = s;
    for (const cb of this.listeners) cb(this.getState());
  }

  async boot(): Promise<void> {
    const key = await readStoredKey(this.secrets);
    this.set(initialState(Boolean(key)));
    if (key) {
      await this.silentValidate();
    }
  }

  async silentValidate(): Promise<LicenseResult> {
    const key = await readStoredKey(this.secrets);
    if (!key) {
      const result: LicenseResult = { ok: false, code: "not_bound", kind: "key", message: "尚未开通" };
      return result;
    }
    if (this.inflight) return this.inflight;
    this.set({ ...this.state, silentChecking: true, hasStoredKey: true });
    this.inflight = this.doValidate(key);
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doValidate(key: string): Promise<LicenseResult> {
    let deviceId: string;
    try {
      deviceId = await this.deviceIdFn();
    } catch {
      const result: LicenseResult = {
        ok: false,
        code: "invalid_request",
        kind: "invalid_request",
        message: "无法计算本机设备标识。",
      };
      this.set(applyFailure(this.state, "invalid_request", "invalid_request", true));
      return result;
    }
    const result = await postLicense(this.api(), "/v1/license/validate", validatePayload(key, deviceId, this.appVersion));
    if (result.ok) {
      this.set(applySuccess(this.state, result.expiresAt ?? null));
    } else {
      const kind = result.kind ?? "key";
      this.set(applyFailure(this.state, result.code ?? "invalid_request", kind, true));
    }
    return result;
  }

  async activate(rawKey: string): Promise<LicenseResult> {
    const key = Normalize(rawKey);
    if (!key) {
      return { ok: false, code: "invalid_request", kind: "invalid_request", message: "请输入 Key。" };
    }
    this.set(applyActivateStart(this.state));
    let deviceId: string;
    try {
      deviceId = await this.deviceIdFn();
    } catch {
      const result: LicenseResult = {
        ok: false,
        code: "invalid_request",
        kind: "invalid_request",
        message: "无法计算本机设备标识。",
      };
      this.set(applyFailure(this.state, "invalid_request", "invalid_request", false));
      return result;
    }
    const result = await postLicense(
      this.api(),
      "/v1/license/activate",
      activatePayload(key, deviceId, this.appVersion, this.labelFn()),
    );
    if (result.ok) {
      await writeStoredKey(this.secrets, key, deviceId);
      this.set(applySuccess(this.state, result.expiresAt ?? null));
    } else {
      const kind = result.kind ?? "key";
      this.set(applyFailure(this.state, result.code ?? "invalid_request", kind, false));
    }
    return result;
  }

  async decideStart(): Promise<StartDecision> {
    const current = decideStart(this.state);
    if (current.action !== "wait") return current;
    this.set(applyPendingStart(this.state, true));
    if (this.inflight) {
      await this.inflight;
    } else {
      await this.silentValidate();
    }
    this.set(applyPendingStart(this.state, false));
    return decideStart(this.state);
  }

  async reenterKey(): Promise<void> {
    await clearStoredKey(this.secrets);
    this.set(initialState(false));
  }
}
