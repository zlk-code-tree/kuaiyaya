import { describe, expect, it } from "vitest";
import { defaultTargetMB } from "../bitrate";
import { itemTargetMB, queueSummaryLine, readSharedTarget, targetSkipsItem } from "../queue";

describe("batch target input", () => {
  it("stays per-file half until a number is entered, and returns to half when cleared", () => {
    const big = 80 * 1024 * 1024;
    const small = 10 * 1024 * 1024;
    expect(readSharedTarget("")).toEqual({ kind: "half" });
    expect(readSharedTarget("   ")).toEqual({ kind: "half" });
    expect(itemTargetMB(big, null)).toBe(defaultTargetMB(big));
    expect(itemTargetMB(small, null)).toBe(defaultTargetMB(small));
    expect(itemTargetMB(big, null)).not.toBe(itemTargetMB(small, null));

    expect(readSharedTarget("25")).toEqual({ kind: "shared", mb: 25 });
    expect(readSharedTarget("25.6")).toEqual({ kind: "shared", mb: 26 });
    expect(itemTargetMB(big, 25)).toBe(25);
    expect(itemTargetMB(small, 25)).toBe(25);
    expect(targetSkipsItem(25, small)).toBe(true);
    expect(targetSkipsItem(25, big)).toBe(false);

    expect(readSharedTarget("")).toEqual({ kind: "half" });
    expect(readSharedTarget("0")).toEqual({ kind: "invalid" });
    expect(readSharedTarget("abc")).toEqual({ kind: "invalid" });
  });

  it("summarizes success, failure, cancellation, skips, and oversized results", () => {
    expect(queueSummaryLine({ success: 2, failed: 1, cancelled: 0, skipped: 0, exceeded: 0 }))
      .toBe("成功 2，失败 1，已取消 0。");
    expect(queueSummaryLine({ success: 2, failed: 0, cancelled: 1, skipped: 1, exceeded: 1 }))
      .toBe("成功 2，失败 0，已取消 1。有 1 条实际体积超出了参考目标。另有 1 条已跳过。");
  });
});