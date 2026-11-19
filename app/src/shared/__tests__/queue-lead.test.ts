import { describe, expect, it } from "vitest";
import { MSG } from "../messages";
import {
  QUEUE_LEAD_PENDING,
  displayedQueueSlots,
  queueConcurrencyLine,
  resolveQueueLead,
} from "../queue";

const SERIAL = "这一次按顺序一支一支压。由这台设备自动决定，单个失败不影响其余。";

describe("queue concurrency copy", () => {
  it("uses min(device cap, items that need compressing) and never says 同时压 1 支", () => {
    expect(displayedQueueSlots(2, 3)).toBe(2);
    expect(displayedQueueSlots(3, 2)).toBe(2);
    expect(displayedQueueSlots(3, 3)).toBe(3);
    expect(displayedQueueSlots(2, 1)).toBe(1);
    expect(displayedQueueSlots(1, 4)).toBe(1);
    expect(displayedQueueSlots(3, 0)).toBe(0);

    expect(queueConcurrencyLine(2)).toBe("这一次同时压 2 支。由这台设备自动决定，单个失败不影响其余。");
    expect(queueConcurrencyLine(3)).toBe("这一次同时压 3 支。由这台设备自动决定，单个失败不影响其余。");
    expect(queueConcurrencyLine(1)).toBe(SERIAL);
    expect(queueConcurrencyLine(0)).toBe(SERIAL);

    for (const limit of [1, 2, 3]) {
      for (const count of [0, 1, 2, 3, 5]) {
        const line = queueConcurrencyLine(displayedQueueSlots(limit, count));
        expect(line).not.toContain("同时压 1");
        const slots = Math.min(limit, count);
        if (slots >= 2) expect(line).toContain(`同时压 ${slots} 支`);
        else expect(line).toBe(SERIAL);
      }
    }
  });

  it("keeps the sentence frozen after start", () => {
    expect(resolveQueueLead(null, 3, null)).toBe(QUEUE_LEAD_PENDING);
    const before = resolveQueueLead(2, 3, null);
    expect(before).toBe("这一次同时压 2 支。由这台设备自动决定，单个失败不影响其余。");
    const frozen = before;
    expect(resolveQueueLead(2, 1, frozen)).toBe(frozen);
    expect(resolveQueueLead(1, 1, frozen)).toBe(frozen);
    expect(resolveQueueLead(3, 0, frozen)).toBe(frozen);
    expect(resolveQueueLead(null, 4, frozen)).toBe(frozen);
    expect(resolveQueueLead(2, 1, null)).toBe(SERIAL);
  });

  it("keeps the single-item cancel title and says the others continue", () => {
    expect(MSG.closeWhileWorkTitle).toBe("确定取消压缩？");
    expect(MSG.queueCancelOneDetail).toContain("只取消这一支，其他正在压的会继续。");
    expect(MSG.queueCloseTitle).toBe("确定取消全部？");
  });
});