import { describe, expect, it } from "vitest";
import { doneSubtitle } from "../done-sub";

const trialNote = "输出文件已保存。实际编码参数与试压不同，请检查画质。";
const saved = "输出文件已保存在原片同一目录";
const reduced = "已压到目标上限以内。为达到这个体积，画质可能略低于按清晰度优先的结果。";

describe("done page subtitle", () => {
  it("adds the quality-reduced note on its own line and does not say the result was saved again", () => {
    const text = doneSubtitle({
      qualityReduced: true,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "videotoolbox",
    });
    expect(text).toBe(`${saved}\n${reduced}`);
    expect(text.split("\n")[1]).not.toContain("已保存");
    expect(text).not.toContain("输出文件已保存。");
    expect(text).not.toContain("实际体积超出了参考目标");
    expect(text).not.toContain(trialNote);
  });

  it("notes a trial only when the quality-first encoder differs", () => {
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "videotoolbox",
    })).toBe(trialNote);
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "videotoolbox",
      analysisEncoder: "videotoolbox",
    })).toBe(saved);
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "x265",
    })).toBe(saved);
  });

  it("keeps the plain saved line when this result did not use a trial", () => {
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: "x265",
    })).toBe(saved);
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: null,
    })).toBe(saved);
  });

  it("does not mention a reference target on a plain success", () => {
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: false,
      encoder: "videotoolbox",
      analysisEncoder: null,
    })).toBe(saved);
  });
});
