export const PREVIEW_MISSING = "找不到输出文件，可能已被移动或删除。";
export const PREVIEW_UNPLAYABLE = "此预览无法在应用内播放，可用「打开文件」用系统播放器查看。";
export const PREVIEW_INTERRUPTED = "预览中断，可再试或改用「打开文件」。";
export const PREVIEW_LOADING = "正在加载预览…";

export type DonePreviewAvailability = "checking" | "missing" | "ready";
export type DonePreviewPhase = "loading" | "ready" | "missing" | "unplayable" | "interrupted";

export interface DonePreviewView {
  phase: DonePreviewPhase;
  /** Mid-play errors keep the element visible so the current frame can stay on screen. */
  showVideo: boolean;
  message: string | null;
  canRetry: boolean;
}

/**
 * Preview failures stay in the player area. They do not change the compress result.
 */
export function donePreviewView(input: {
  availability: DonePreviewAvailability;
  loaded: boolean;
  played: boolean;
  errored: boolean;
}): DonePreviewView {
  if (input.availability === "checking") {
    return { phase: "loading", showVideo: false, message: PREVIEW_LOADING, canRetry: false };
  }
  if (input.availability === "missing") {
    return { phase: "missing", showVideo: false, message: PREVIEW_MISSING, canRetry: false };
  }
  if (input.errored) {
    if (input.played) {
      return { phase: "interrupted", showVideo: true, message: PREVIEW_INTERRUPTED, canRetry: true };
    }
    return { phase: "unplayable", showVideo: false, message: PREVIEW_UNPLAYABLE, canRetry: true };
  }
  if (!input.loaded) {
    return { phase: "loading", showVideo: false, message: PREVIEW_LOADING, canRetry: false };
  }
  return { phase: "ready", showVideo: true, message: null, canRetry: false };
}

export interface PreviewVideoElement {
  pause(): void;
  removeAttribute(qualifiedName: string): void;
  load(): void;
}

/** Pause and drop the media address so the finished file is not held open. */
export function clearPreviewVideo(video: PreviewVideoElement): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/**
 * A paused seek of this size, then back to 0, asks the engine to paint the first frame
 * without starting playback.
 */
export function firstFrameNudge(durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const nudge = Math.min(0.001, durationSec / 2);
  return nudge > 0 ? nudge : null;
}
