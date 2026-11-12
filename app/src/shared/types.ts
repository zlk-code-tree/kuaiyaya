export type AppScreen =
  | "screen-key"
  | "screen-idle"
  | "screen-ready"
  | "screen-work"
  | "screen-done"
  | "screen-fail";

export type EncoderKind = "videotoolbox" | "x265";

export interface ProbeInfo {
  path: string;
  name: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  rotation: number;
  displayWidth: number;
  displayHeight: number;
  videoCodec: string;
  hasAudio: boolean;
  container: string;
}

export interface StartInput {
  filePath: string;
  targetMB: number;
}

export interface GuardResult {
  ok: boolean;
  reason?: "target_too_large" | "disk_low" | "no_write" | "unsupported";
  message?: string;
  requiredMB?: number;
}

export interface ProgressEvent {
  encoder: EncoderKind;
  phase: "pass1" | "pass2" | "single" | "retry";
  ratio: number;
  percent: number;
  etaSec: number | null;
  message: string;
}

export interface DoneEvent {
  outputPath: string;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  encoder: EncoderKind;
  retried: boolean;
}

export interface FailEvent {
  message: string;
  cancelled?: boolean;
}

export type LicenseCode =
  | "ok"
  | "invalid"
  | "expired"
  | "device_bound_to_other_key"
  | "key_bound_to_other_device"
  | "not_bound"
  | "invalid_request";

export type LicenseErrorKind = "network" | "key" | "invalid_request";

export interface LicenseState {
  hasStoredKey: boolean;
  verified: boolean;
  silentChecking: boolean;
  pendingStart: boolean;
  lastCode: LicenseCode | "network" | null;
  lastKind: LicenseErrorKind | "ok" | null;
  expiresAt: string | null;
  banner: { text: string; showReenter: boolean } | null;
}

export interface LicenseResult {
  ok: boolean;
  code?: LicenseCode | "network";
  kind?: LicenseErrorKind;
  message: string;
  expiresAt?: string | null;
}

export interface EncoderCaps {
  x265: boolean;
  videotoolbox: boolean;
  ffmpegVersion: string;
  probedAt: string;
  ffmpegPath: string;
}

export interface AboutInfo {
  name: string;
  version: string;
  maintainer: string;
  email: string;
  qrSrc: string;
}

export interface KuaiyayaAPI {
  selectVideo(): Promise<string | null>;
  probe(filePath: string): Promise<ProbeInfo>;
  checkStartGuards(input: StartInput): Promise<GuardResult>;
  startCompress(input: StartInput): Promise<void>;
  cancelCompress(): Promise<void>;
  onCompressProgress(cb: (e: ProgressEvent) => void): () => void;
  onCompressDone(cb: (e: DoneEvent) => void): () => void;
  onCompressFail(cb: (e: FailEvent) => void): () => void;
  openFile(filePath: string): Promise<void>;
  revealInFinder(filePath: string): Promise<void>;
  license: {
    getState(): Promise<LicenseState>;
    activate(key: string): Promise<LicenseResult>;
    reenter(): Promise<void>;
    onChange(cb: (s: LicenseState) => void): () => void;
  };
  about(): Promise<AboutInfo>;
  copyText(text: string): Promise<void>;
  getEncoderCaps(): Promise<EncoderCaps>;
  resolveDropPath(file: File): string;
  onOpenFile(cb: (filePath: string) => void): () => void;
}

declare global {
  interface Window {
    kuaiyaya: KuaiyayaAPI;
  }
}

export {};
