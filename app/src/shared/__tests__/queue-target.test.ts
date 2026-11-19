import { describe, expect, it } from "vitest";
import { carriedCapMB, itemTargetMB, queueStartAllowed, queueSummaryLine, queueTargetTextFromReady, readSharedTarget, targetSkipsItem } from "../queue";

describe("batch target input", () => {
  it("stays empty until a number is entered, and returns to empty when cleared", () => {
    const big = 80 * 1024 * 1024;
    const small = 10 * 1024 * 1024;
    expect(readSharedTarget("")).toEqual({ kind: "quality" });
    expect(readSharedTarget("   ")).toEqual({ kind: "quality" });
    expect(itemTargetMB(big, null)).toBeNull();
    expect(itemTargetMB(small, null)).toBeNull();
    expect(targetSkipsItem(null, small)).toBe(false);
    expect(targetSkipsItem(null, big)).toBe(false);

    expect(readSharedTarget("25")).toEqual({ kind: "shared", mb: 25 });
    expect(readSharedTarget("25.6")).toEqual({ kind: "shared", mb: 26 });
    expect(itemTargetMB(big, 25)).toBe(25);
    expect(itemTargetMB(small, 25)).toBe(25);
    expect(targetSkipsItem(25, small)).toBe(true);
    expect(targetSkipsItem(25, big)).toBe(false);

    expect(readSharedTarget("")).toEqual({ kind: "quality" });
    expect(readSharedTarget("0")).toEqual({ kind: "invalid" });
    expect(readSharedTarget("abc")).toEqual({ kind: "invalid" });
  });

  it("allows start when the field is empty or every item would be skipped, and only carries a filled cap", () => {
    expect(queueStartAllowed({ kind: "quality" })).toBe(true);
    expect(queueStartAllowed({ kind: "shared", mb: 10 })).toBe(true);
    expect(queueStartAllowed({ kind: "invalid" })).toBe(false);
    expect(carriedCapMB({ kind: "shared", mb: 30 })).toBe(30);
    expect(carriedCapMB({ kind: "quality" })).toBeNull();
    expect(carriedCapMB({ kind: "invalid" })).toBeNull();
    expect(queueTargetTextFromReady(30)).toBe("30");
    expect(queueTargetTextFromReady(null)).toBe("");
    expect(queueTargetTextFromReady(Number.NaN)).toBe("");
    expect(readSharedTarget(queueTargetTextFromReady(null)).kind).toBe("quality");
  });

  it("summarizes success, failure, cancellation, and skips without a reference-target line", () => {
    expect(queueSummaryLine({ success: 2, failed: 1, cancelled: 0, skipped: 0 }))
      .toBe("成功 2，失败 1，已取消 0。");
    expect(queueSummaryLine({ success: 2, failed: 0, cancelled: 1, skipped: 1 }))
      .toBe("成功 2，失败 0，已取消 1。另有 1 条已跳过。");
    expect(queueSummaryLine({ success: 0, failed: 0, cancelled: 0, skipped: 3 }))
      .toBe("成功 0，失败 0，已取消 0。另有 3 条已跳过。");
    expect(queueSummaryLine({ success: 1, failed: 0, cancelled: 0, skipped: 0 })).not.toContain("参考目标");
  });
});
