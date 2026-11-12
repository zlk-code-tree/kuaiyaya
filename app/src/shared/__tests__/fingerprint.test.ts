import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeDeviceId, isDeviceId } from "../fingerprint";
import { FINGERPRINT_SALT } from "../messages";

describe("device fingerprint v1", () => {
  it("uses kuaiyaya.v1 | hw | install and lowercase hex", () => {
    const id = computeDeviceId("HW-UUID", "VOL-UUID");
    const expected = createHash("sha256").update("kuaiyaya.v1|HW-UUID|VOL-UUID", "utf8").digest("hex");
    expect(id).toBe(expected);
    expect(isDeviceId(id)).toBe(true);
    expect(FINGERPRINT_SALT).toBe("kuaiyaya.v1");
    expect(id).not.toMatch(/[A-F]/);
  });

  it("changes when either component changes, and is stable otherwise", () => {
    const a = computeDeviceId("A", "B");
    expect(computeDeviceId("A", "B")).toBe(a);
    expect(computeDeviceId("A", "C")).not.toBe(a);
    expect(computeDeviceId("Z", "B")).not.toBe(a);
  });
});
