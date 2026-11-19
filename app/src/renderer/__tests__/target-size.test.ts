import { describe, expect, it } from "vitest";
import { applyInput, blocksStart, emptyTarget, targetAfterAnalysis, tooLarge } from "../state/target-size";

describe("single-file size field", () => {
  it("starts empty and does not turn a cleared field into half the source", () => {
    const state = emptyTarget(80 * 1024 * 1024);
    expect(state.targetMB).toBeNull();
    expect(tooLarge(state)).toBe(false);
    expect(blocksStart(state)).toBe(false);
    expect(applyInput(state, Number.NaN).targetMB).toBeNull();
    expect(applyInput(state, 0).invalid).toBe(true);
  });

  it("does not write the trial estimate until the user chooses it as a limit", () => {
    const state = emptyTarget(200 * 1024 * 1024);
    expect(targetAfterAnalysis(state, 40, false).targetMB).toBeNull();
    const applied = targetAfterAnalysis(state, 40.4, true);
    expect(applied.targetMB).toBe(40);
    expect(applied.invalid).toBe(false);
    expect(targetAfterAnalysis(applied, 55, false).targetMB).toBe(40);
  });

  it("treats a filled number as a limit and blocks only when it is not smaller than the source", () => {
    const state = emptyTarget(40 * 1024 * 1024);
    const limit = applyInput(state, 39);
    expect(limit.targetMB).toBe(39);
    expect(tooLarge(limit)).toBe(false);
    expect(tooLarge(applyInput(state, 40))).toBe(true);
    expect(blocksStart(applyInput(state, 40))).toBe(true);
  });
});
