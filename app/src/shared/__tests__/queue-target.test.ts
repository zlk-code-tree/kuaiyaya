import { describe, expect, it } from "vitest";
import { itemTargetMB, queueCanStart, queueSummaryLine, readSharedTarget, targetLabel, targetSkipsItem } from "../queue";

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
    expect(targetLabel(null)).toBe("按清晰度自动压");

    expect(readSharedTarget("25")).toEqual({ kind: "shared", mb: 25 });
    expect(readSharedTarget("25.6")).toEqual({ kind: "shared", mb: 26 });
    expect(itemTargetMB(big, 25)).toBe(25);
    expect(itemTargetMB(small, 25)).toBe(25);
    expect(targetLabel(25)).toBe("上限 25 MB");
    expect(targetSkipsItem(25, small)).toBe(true);
    expect(targetSkipsItem(25, big)).toBe(false);

    expect(readSharedTarget("")).toEqual({ kind: "quality" });
    expect(readSharedTarget("0")).toEqual({ kind: "invalid" });
    expect(readSharedTarget("abc")).toEqual({ kind: "invalid" });
  });

  it("keeps start enabled when every readable item would be skipped", () => {
    const small = 10 * 1024 * 1024;
    const big = 80 * 1024 * 1024;
    const skipped = {
      started: false,
      target: { kind: "shared" as const, mb: 25 },
      items: [
        { readable: true, sizeBytes: small },
        { readable: true, sizeBytes: small },
      ],
    };
    expect(queueCanStart(skipped)).toBe(true);
    expect(queueCanStart({
      started: false,
      target: { kind: "quality" },
      items: [{ readable: true, sizeBytes: small }],
    })).toBe(true);
    expect(queueCanStart({
      started: false,
      target: { kind: "shared", mb: 25 },
      items: [
        { readable: true, sizeBytes: small },
        { readable: true, sizeBytes: big },
      ],
    })).toBe(true);
    expect(queueCanStart({ ...skipped, target: { kind: "invalid" } })).toBe(false);
    expect(queueCanStart({ ...skipped, started: true })).toBe(false);
    expect(queueCanStart({
      started: false,
      target: { kind: "quality" },
      items: [{ readable: false, sizeBytes: 0 }],
    })).toBe(false);
  });

  it("summarizes success, failure, cancellation, and skips without a reference-target line", () => {
    expect(queueSummaryLine({ success: 2, failed: 1, cancelled: 0, skipped: 0 }))
      .toBe("成功 2，失败 1，已取消 0。");
    expect(queueSummaryLine({ success: 2, failed: 0, cancelled: 1, skipped: 1 }))
      .toBe("成功 2，失败 0，已取消 1。另有 1 条已跳过。");
    expect(queueSummaryLine({ success: 0, failed: 0, cancelled: 0, skipped: 2 }))
      .toBe("成功 0，失败 0，已取消 0。另有 2 条已跳过。");
    expect(queueSummaryLine({ success: 1, failed: 0, cancelled: 0, skipped: 0 })).not.toContain("参考目标");
  });
});
