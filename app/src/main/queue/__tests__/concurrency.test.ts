import { describe, expect, it } from "vitest";
import { queueConcurrency, readChipFacts, type QueueDeviceFacts } from "../concurrency";

const GIB = 1024 * 1024 * 1024;

function facts(over: Partial<QueueDeviceFacts> = {}): QueueDeviceFacts {
  return {
    platform: "darwin",
    videotoolbox: true,
    brand: "Apple M1 Pro",
    totalMemBytes: 16 * GIB,
    perfCores: 6,
    ...over,
  };
}

describe("queueConcurrency", () => {
  it("gives an M1 or M2 Pro with 16 GB two slots", () => {
    expect(queueConcurrency(facts({ brand: "Apple M1 Pro", totalMemBytes: 16 * GIB }))).toBe(2);
    expect(queueConcurrency(facts({ brand: "Apple M2 Pro", totalMemBytes: 16 * GIB, perfCores: null }))).toBe(2);
    expect(queueConcurrency(facts({ brand: "apple m3 pro", totalMemBytes: 18 * GIB }))).toBe(2);
    expect(queueConcurrency(facts({ brand: "Apple M4 Pro", totalMemBytes: 16 * GIB }))).toBe(2);
  });

  it("gives Max and Ultra three slots", () => {
    expect(queueConcurrency(facts({ brand: "Apple M1 Max", totalMemBytes: 32 * GIB }))).toBe(3);
    expect(queueConcurrency(facts({ brand: "Apple M2 Ultra", totalMemBytes: 64 * GIB, perfCores: null }))).toBe(3);
    expect(queueConcurrency(facts({ brand: "Apple M3 Max", totalMemBytes: 16 * GIB }))).toBe(3);
    expect(queueConcurrency(facts({ brand: "Apple M4 Ultra", totalMemBytes: 8 * GIB }))).toBe(3);
  });

  it("keeps a base M-series chip serial even with enough RAM and cores", () => {
    expect(queueConcurrency(facts({ brand: "Apple M1", totalMemBytes: 8 * GIB, perfCores: 4 }))).toBe(1);
    expect(queueConcurrency(facts({ brand: "Apple M2", totalMemBytes: 8 * GIB }))).toBe(1);
    expect(queueConcurrency(facts({ brand: "Apple M3", totalMemBytes: 16 * GIB, perfCores: 8 }))).toBe(1);
    expect(queueConcurrency(facts({ brand: "Apple M4", totalMemBytes: 32 * GIB, perfCores: 10 }))).toBe(1);
  });

  it("stays serial for Intel, for machines without VideoToolbox, and off macOS", () => {
    expect(queueConcurrency(facts({
      brand: "Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz",
      totalMemBytes: 32 * GIB,
      perfCores: 8,
    }))).toBe(1);
    expect(queueConcurrency(facts({ videotoolbox: false, brand: "Apple M1 Max", totalMemBytes: 64 * GIB }))).toBe(1);
    expect(queueConcurrency(facts({ platform: "win32", brand: "Apple M1 Pro" }))).toBe(1);
    expect(queueConcurrency(facts({ platform: "linux", brand: "Apple M1 Max", totalMemBytes: 64 * GIB }))).toBe(1);
    expect(queueConcurrency(facts({ brand: "Some other CPU", totalMemBytes: 64 * GIB, perfCores: 16 }))).toBe(1);
  });

  it("drops a Pro below 16 GB to one slot", () => {
    expect(queueConcurrency(facts({ brand: "Apple M1 Pro", totalMemBytes: 16 * GIB - 1 }))).toBe(1);
    expect(queueConcurrency(facts({ brand: "Apple M2 Pro", totalMemBytes: 8 * GIB }))).toBe(1);
  });

  it("falls back to cores and RAM only when the brand string is missing", () => {
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 32 * GIB, perfCores: 8 }))).toBe(3);
    expect(queueConcurrency(facts({ brand: "  ", totalMemBytes: 32 * GIB, perfCores: 8 }))).toBe(3);
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 16 * GIB, perfCores: 6 }))).toBe(2);
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 16 * GIB, perfCores: 5 }))).toBe(1);
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 16 * GIB, perfCores: null }))).toBe(1);
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 32 * GIB, perfCores: null }))).toBe(1);
    expect(queueConcurrency(facts({ brand: null, totalMemBytes: 8 * GIB, perfCores: 8 }))).toBe(1);
    expect(queueConcurrency(facts({ brand: null, videotoolbox: false, totalMemBytes: 64 * GIB, perfCores: 12 }))).toBe(1);
  });
});

describe("readChipFacts", () => {
  it("does not throw, and on non-macOS does not invent a chip", async () => {
    const chip = await readChipFacts();
    expect(chip.totalMemBytes).toBeGreaterThan(0);
    if (process.platform !== "darwin") {
      expect(chip.brand).toBeNull();
      expect(chip.perfCores).toBeNull();
    }
  });
});
