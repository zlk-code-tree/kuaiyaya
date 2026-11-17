import { describe, expect, it } from "vitest";
import { doneSubtitle } from "../done-sub";

const trialNote = "输出文件已保存。实际编码参数与试压不同，请检查画质。";

describe("done page subtitle", () => {
  it("splits the two notes onto separate lines and does not repeat 已保存", () => {
    const text = doneSubtitle({
      exceededTarget: true,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "x265",
    });
    expect(text).toBe(`实际体积超出了参考目标。\n${trialNote}`);
    expect(text.split("\n")[0]).toBe("实际体积超出了参考目标。");
    expect(text.split("\n")[0]).not.toContain("已保存");
    expect(text.match(/已保存/g)).toEqual(["已保存"]);
    expect(text).not.toContain("输出已保存");
  });

  it("notes the bitrate trial when the official encoder kind is unchanged", () => {
    expect(doneSubtitle({
      exceededTarget: false,
      usedAnalysis: true,
      encoder: "videotoolbox",
      analysisEncoder: "videotoolbox",
    })).toBe(trialNote);
    expect(doneSubtitle({
      exceededTarget: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "x265",
    })).toBe(trialNote);
  });

  it("still notes the trial when the encoder kind changes", () => {
    expect(doneSubtitle({
      exceededTarget: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: "videotoolbox",
    })).toBe(trialNote);
  });

  it("keeps the plain saved line when this result did not use a trial", () => {
    expect(doneSubtitle({
      exceededTarget: false,
      usedAnalysis: false,
      encoder: "x265",
      analysisEncoder: "x265",
    })).toBe("输出文件已保存在原片同一目录");
    expect(doneSubtitle({
      exceededTarget: false,
      usedAnalysis: true,
      encoder: "x265",
      analysisEncoder: null,
    })).toBe("输出文件已保存在原片同一目录");
  });

  it("shows only the reference-target note when nothing was trialed", () => {
    expect(doneSubtitle({
      exceededTarget: true,
      usedAnalysis: false,
      encoder: "videotoolbox",
      analysisEncoder: null,
    })).toBe("实际体积超出了参考目标。");
  });
});
