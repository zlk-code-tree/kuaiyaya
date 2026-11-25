import { describe, expect, it } from "vitest";
import { normalizeOutputPlan, outputPlanProblem, patternProblem, plannedOutputName, renderPatternName } from "../filename";

describe("output filename pattern", () => {
  it("leaves an empty pattern on the resolution name", () => {
    const small = { width: 1280, height: 720 };
    expect(plannedOutputName("/tmp/假期.mov", small, "")).toBe("假期_720p.mp4");
    expect(plannedOutputName("/tmp/假期.mov", small, "   ")).toBe("假期_720p.mp4");
    expect(plannedOutputName("/tmp/假期.mov", { width: 1920, height: 1080 }, null)).toBe("假期_1080p.mp4");
  });

  it("replaces {originalStem} and keeps the name inside one folder", () => {
    expect(renderPatternName("/tmp/假期.mov", "{originalStem}_1080p.mp4")).toBe("假期_1080p.mp4");
    expect(renderPatternName("/tmp/假期.mov", "{originalStem}_mail")).toBe("假期_mail.mp4");
    expect(renderPatternName("/tmp/假期.mov", "..")).toBe("假期_1080p.mp4");
    expect(renderPatternName("/tmp/假期.mov", "../secret")).toBe("..secret.mp4");
    expect(patternProblem("{originalStem}/../x")).toBe("文件名不能包含文件夹。");
    expect(patternProblem("a:b")).toBe("文件名包含不能使用的字符。");
    expect(patternProblem("{originalStem}_1080p.mp4")).toBeNull();
    expect(outputPlanProblem(normalizeOutputPlan({ directory: "  /out  ", pattern: "  " }))).toBeNull();
    expect(normalizeOutputPlan({ directory: "  /out  ", pattern: "  " })).toEqual({ directory: "/out", pattern: null });
  });
});
