import { describe, expect, it } from "vitest";
import { doneSubtitle } from "../done-sub";

const saved = "输出文件已保存在原片同一目录";
const reduced = "已压到目标上限以内。为达到这个体积，画质可能略低于按清晰度优先的结果。";
const trialNote = "输出文件已保存。实际编码参数与试压不同，请检查画质。";

describe("done page subtitle", () => {
  it("keeps the saved line when nothing was trialed or the quality-first encoder matches", () => {
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: null,
    })).toBe(saved);
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

  it("keeps the trial note only when this round's quality-first encoder differs", () => {
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "videotoolbox",
    })).toBe(trialNote);
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: null,
    })).toBe(saved);
  });

  it("adds the quality-reduced line without stacking the trial note or repeating 已保存", () => {
    const text = doneSubtitle({
      qualityReduced: true,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "videotoolbox",
    });
    expect(text).toBe(`${saved}\n${reduced}`);
    expect(text.split("\n")[1]).toBe(reduced);
    expect(text).not.toContain("输出文件已保存。");
    expect(text).not.toContain(trialNote);
    expect(text).not.toContain("实际体积超出了参考目标");
    expect(reduced).not.toContain("已保存");
  });

  it("says the file went to the chosen folder when the user picked one", () => {
    const chosen = "输出文件已保存到所选文件夹";
    expect(doneSubtitle({
      qualityReduced: false,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: null,
      customDirectory: true,
    })).toBe(chosen);
    expect(doneSubtitle({
      qualityReduced: true,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: null,
      customDirectory: true,
    })).toBe(`${chosen}\n${reduced}`);
  });
});
