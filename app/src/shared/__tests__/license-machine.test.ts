import { describe, expect, it } from "vitest";
import {
  applyFailure,
  applyPendingStart,
  applySilentStart,
  applySuccess,
  canCompress,
  decideStart,
  initialState,
} from "../license-machine";

describe("license session state machine", () => {
  it("opens the key screen when there is no stored key", () => {
    const s = initialState(false);
    expect(s.hasStoredKey).toBe(false);
    expect(s.silentChecking).toBe(false);
    expect(canCompress(s)).toBe(false);
    const d = decideStart(s);
    expect(d.action).toBe("block");
  });

  it("enters the main UI and silently checks when a key is stored", () => {
    const s = initialState(true);
    expect(s.silentChecking).toBe(true);
    expect(s.verified).toBe(false);
    expect(canCompress(s)).toBe(false);
    expect(decideStart(s).action).toBe("wait");
  });

  it("starts immediately once this process has verified", () => {
    let s = initialState(true);
    s = applySuccess(s, "2027-01-01T15:59:59.000Z");
    expect(canCompress(s)).toBe(true);
    expect(s.banner).toBeNull();
    expect(decideStart(s).action).toBe("start");
  });

  it("only shows a banner after a failed silent check, and never treats last success as a pass", () => {
    let s = initialState(true);
    s = applyFailure(s, "expired", "key", true);
    expect(s.verified).toBe(false);
    expect(s.banner?.text).toMatch(/过期/);
    expect(canCompress(s)).toBe(false);
    const d = decideStart(s);
    expect(d.action).toBe("block");
    if (d.action === "block") {
      expect(d.code).toBe("expired");
      expect(d.message).not.toMatch(/网络不通/);
    }
  });

  it("keeps waiting, not a dialog, while a silent check is in flight", () => {
    let s = initialState(true);
    s = applySilentStart(s);
    s = applyPendingStart(s, true);
    expect(decideStart(s).action).toBe("wait");
  });

  it("separates network failure from key failure", () => {
    let s = initialState(true);
    s = applyFailure(s, "network", "network", true);
    expect(s.banner?.text).toMatch(/网络不通/);
    expect(s.banner?.showReenter).toBe(false);
    const d = decideStart(s);
    if (d.action === "block") {
      expect(d.message).toMatch(/不是 Key 无效或过期/);
    }
  });

  it("does not mark verified after not_bound", () => {
    let s = initialState(true);
    s = applyFailure(s, "not_bound", "key", true);
    expect(s.verified).toBe(false);
    expect(s.banner?.text).toMatch(/绑定已解除/);
  });
});
