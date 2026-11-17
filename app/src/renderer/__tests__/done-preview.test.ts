import { describe, expect, it } from "vitest";
import { MSG } from "../../shared/messages";
import { doneSubtitle } from "../done-sub";
import {
  PREVIEW_INTERRUPTED,
  PREVIEW_LOADING,
  PREVIEW_MISSING,
  PREVIEW_UNPLAYABLE,
  clearPreviewVideo,
  donePreviewView,
  firstFrameNudge,
} from "../done-preview";

describe("done page preview state", () => {
  it("uses the product copy when the output file is gone and does not call that a compress failure", () => {
    const view = donePreviewView({ availability: "missing", loaded: false, played: false, errored: false });
    expect(view).toEqual({
      phase: "missing",
      showVideo: false,
      message: PREVIEW_MISSING,
      canRetry: false,
    });
    expect(PREVIEW_MISSING).toBe("找不到输出文件，可能已被移动或删除。");
    expect(PREVIEW_MISSING).not.toBe(MSG.missingOutput);
    expect(MSG.missingOutput).toBe("文件已不在原位置。");
    expect(view.message).not.toContain("压缩失败");
  });

  it("shows a light loading state, then the paused first frame, without a message", () => {
    expect(donePreviewView({ availability: "checking", loaded: false, played: false, errored: false })).toMatchObject({
      phase: "loading",
      showVideo: false,
      message: PREVIEW_LOADING,
      canRetry: false,
    });
    expect(donePreviewView({ availability: "ready", loaded: false, played: false, errored: false }).phase).toBe("loading");
    expect(donePreviewView({ availability: "ready", loaded: true, played: false, errored: false })).toEqual({
      phase: "ready",
      showVideo: true,
      message: null,
      canRetry: false,
    });
    expect(firstFrameNudge(12)).toBe(0.001);
    expect(firstFrameNudge(0.0004)).toBeCloseTo(0.0002, 6);
    expect(firstFrameNudge(0)).toBeNull();
    expect(firstFrameNudge(Number.NaN)).toBeNull();
  });

  it("explains an in-app decode failure without touching the success subtitle", () => {
    const view = donePreviewView({ availability: "ready", loaded: false, played: false, errored: true });
    expect(view).toEqual({
      phase: "unplayable",
      showVideo: false,
      message: PREVIEW_UNPLAYABLE,
      canRetry: true,
    });
    expect(PREVIEW_UNPLAYABLE).toBe("此预览无法在应用内播放，可用「打开文件」用系统播放器查看。");
    const subtitle = doneSubtitle({
      exceededTarget: true,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: null,
    });
    expect(subtitle).toBe("实际体积超出了参考目标。");
    expect(view.message).not.toContain(subtitle);
    expect(view.message).not.toContain("压缩失败");
  });

  it("keeps the current frame on a mid-play error and offers another try", () => {
    const view = donePreviewView({ availability: "ready", loaded: true, played: true, errored: true });
    expect(view).toEqual({
      phase: "interrupted",
      showVideo: true,
      message: PREVIEW_INTERRUPTED,
      canRetry: true,
    });
    expect(PREVIEW_INTERRUPTED).toBe("预览中断，可再试或改用「打开文件」。");
    expect(view.message).not.toContain("压缩失败");
  });

  it("pauses and clears the media address when leaving the page", () => {
    const calls: string[] = [];
    clearPreviewVideo({
      pause: () => calls.push("pause"),
      removeAttribute: (name) => calls.push(`remove:${name}`),
      load: () => calls.push("load"),
    });
    expect(calls).toEqual(["pause", "remove:src", "load"]);
  });
});
