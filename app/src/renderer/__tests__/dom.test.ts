import { describe, expect, it } from "vitest";
import { formatElapsed, formatEta, formatRemainDetail } from "../dom";

describe("formatEta", () => {
  it("does not say almost done while progress is still low", () => {
    expect(formatEta(null)).toBe("计算预计时间…");
    expect(formatEta(3, 10)).toBe("计算预计时间…");
    expect(formatEta(3, 96)).toBe("即将完成");
    expect(formatEta(3)).toBe("即将完成");
    expect(formatEta(20, 10)).toBe("预计剩余 20秒");
  });
});

describe("formatRemainDetail and formatElapsed", () => {
  it("shows elapsed and estimated total alongside remaining", () => {
    expect(formatElapsed(80)).toBe("已用 1分20秒");
    expect(formatRemainDetail(80, 20, 80)).toBe("预计剩余 20秒（共约 1分40秒）");
    expect(formatRemainDetail(8, null)).toBe("计算预计时间…");
    expect(formatRemainDetail(200, 3, 97)).toBe("即将完成");
  });
});
