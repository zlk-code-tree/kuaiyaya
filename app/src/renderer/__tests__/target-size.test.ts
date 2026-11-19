import { describe, expect, it } from "vitest";
import { defaultTargetMB } from "../../shared/bitrate";
import { applySlider, applyTyped, fromFileSize, tooLarge } from "../state/target-size";

describe("ready page target", () => {
  it("starts empty and does not prefill half of the source", () => {
    const size = 100 * 1024 * 1024;
    const state = fromFileSize(size);
    expect(state.targetMB).toBeNull();
    expect(state.invalid).toBe(false);
    expect(state.targetMB).not.toBe(defaultTargetMB(size));
    expect(tooLarge(state)).toBe(false);
  });

  it("carries a filled cap back and stays empty when the queue field was empty", () => {
    const size = 100 * 1024 * 1024;
    expect(fromFileSize(size, 30).targetMB).toBe(30);
    expect(fromFileSize(size, null).targetMB).toBeNull();
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

  it("blocks only a filled cap that is not smaller than the source", () => {
    const size = 10 * 1024 * 1024;
    expect(tooLarge(fromFileSize(size))).toBe(false);
    expect(tooLarge(fromFileSize(size, 9))).toBe(false);
    expect(tooLarge(fromFileSize(size, 10))).toBe(true);
  });
});
