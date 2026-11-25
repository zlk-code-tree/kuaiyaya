import { describe, expect, it } from "vitest";
import { defaultTargetMB } from "../../shared/bitrate";
import { carriedCapMB, queueTargetTextFromReady, readSharedTarget } from "../../shared/queue";
import { SIZE_PRESETS_MB, applySlider, applyTyped, fromFileSize, sliderThumbMB, tooLarge } from "../state/target-size";

describe("ready page target", () => {
  it("starts empty and does not prefill half of the source", () => {
    const size = 100 * 1024 * 1024;
    const state = fromFileSize(size);
    expect(state.targetMB).toBeNull();
    expect(state.invalid).toBe(false);
    expect(state.targetMB).not.toBe(defaultTargetMB(size));
    expect(tooLarge(state)).toBe(false);
  });

  it("carries a filled cap both ways and keeps an empty field empty", () => {
    const size = 100 * 1024 * 1024;
    expect(queueTargetTextFromReady(30)).toBe("30");
    expect(readSharedTarget(queueTargetTextFromReady(30))).toEqual({ kind: "shared", mb: 30 });
    expect(fromFileSize(size, carriedCapMB(readSharedTarget("30"))).targetMB).toBe(30);

    expect(queueTargetTextFromReady(null)).toBe("");
    expect(readSharedTarget(queueTargetTextFromReady(null))).toEqual({ kind: "quality" });
    expect(fromFileSize(size, carriedCapMB(readSharedTarget(""))).targetMB).toBeNull();
    expect(queueTargetTextFromReady(null)).not.toBe("1");
    expect(fromFileSize(size).targetMB).not.toBe(1);
  });

  it("does not give an empty cap a slider position at 1 MB", () => {
    const size = 100 * 1024 * 1024;
    const empty = fromFileSize(size);
    expect(sliderThumbMB(empty)).toBeNull();
    expect(sliderThumbMB(applyTyped(fromFileSize(size, 20), ""))).toBeNull();
    expect(sliderThumbMB(applyTyped(empty, "abc"))).toBeNull();
    expect(sliderThumbMB(fromFileSize(size, 1))).toBe(1);
    expect(sliderThumbMB(fromFileSize(size, 24))).toBe(24);
  });

  it("returns to empty when the field is cleared and does not invent a number", () => {
    const size = 80 * 1024 * 1024;
    const cleared = applyTyped(fromFileSize(size, 20), "   ");
    expect(cleared.targetMB).toBeNull();
    expect(cleared.invalid).toBe(false);
    expect(applyTyped(fromFileSize(size), "abc").invalid).toBe(true);
    expect(applyTyped(fromFileSize(size), "abc").targetMB).toBeNull();
    expect(applySlider(fromFileSize(size), 24).targetMB).toBe(24);
  });

  it("fills 10 MB or 25 MB from a preset and still clears back to quality-first", () => {
    expect(SIZE_PRESETS_MB).toEqual([10, 25]);
    const size = 100 * 1024 * 1024;
    const ten = applyTyped(fromFileSize(size), String(SIZE_PRESETS_MB[0]));
    expect(ten.targetMB).toBe(10);
    expect(ten.invalid).toBe(false);
    const tweaked = applyTyped(ten, "18");
    expect(tweaked.targetMB).toBe(18);
    const twentyFive = applyTyped(tweaked, String(SIZE_PRESETS_MB[1]));
    expect(twentyFive.targetMB).toBe(25);
    const cleared = applyTyped(twentyFive, "");
    expect(cleared.targetMB).toBeNull();
    expect(cleared.invalid).toBe(false);
    expect(tooLarge(cleared)).toBe(false);
  });

  it("blocks only a filled cap that is not smaller than the source", () => {
    const size = 10 * 1024 * 1024;
    expect(tooLarge(fromFileSize(size))).toBe(false);
    expect(tooLarge(fromFileSize(size, 9))).toBe(false);
    expect(tooLarge(fromFileSize(size, 10))).toBe(true);
  });
});
