import { describe, expect, it } from "vitest";
import { etaSeconds, parseClockToUs, parseProgressLine, ratioFromOutTime } from "../progress";

describe("parseProgressLine", () => {
  it("reads out_time_us and end markers", () => {
    expect(parseProgressLine("out_time_us=1500000")).toEqual({ outTimeUs: 1_500_000 });
    expect(parseProgressLine("progress=end")).toEqual({ done: true });
    expect(parseProgressLine("frame=12")).toEqual({});
  });

  it("reads out_time clock and out_time_ns", () => {
    expect(parseProgressLine("out_time=00:00:01.500000")).toEqual({ outTimeUs: 1_500_000 });
    expect(parseProgressLine("out_time_ns=1500000000")).toEqual({ outTimeUs: 1_500_000 });
  });

  it("ignores negative or invalid values", () => {
    expect(parseProgressLine("out_time_us=-1")).toEqual({});
    expect(parseClockToUs("n/a")).toBeUndefined();
  });
});

describe("ratio and eta", () => {
  it("clamps ratio and withholds early eta", () => {
    expect(ratioFromOutTime(500_000, 1)).toBe(0.5);
    expect(ratioFromOutTime(9_000_000, 1)).toBe(1);
    expect(etaSeconds(0.02, 5000)).toBeNull();
    expect(etaSeconds(0.5, 1000)).toBe(1);
  });
});
