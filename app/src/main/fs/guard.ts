import { access, constants, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { GuardResult, ProbeInfo } from "../../shared/types";
import { isTargetTooLarge, requiredDiskBytes } from "../../shared/bitrate";
import { MSG } from "../../shared/messages";

export async function checkGuards(probe: ProbeInfo, targetMB: number): Promise<GuardResult> {
  if (isTargetTooLarge(targetMB, probe.sizeBytes)) {
    return { ok: false, reason: "target_too_large", message: MSG.targetTooLarge };
  }
  const dir = dirname(probe.path);
  try {
    await access(dir, constants.W_OK);
  } catch {
    return { ok: false, reason: "no_write", message: MSG.noWrite };
  }
  const need = requiredDiskBytes(targetMB, probe.sizeBytes);
  try {
    const fs = await statfs(dir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < need) {
      const needMB = Math.ceil(need / (1024 * 1024));
      return {
        ok: false,
        reason: "disk_low",
        requiredMB: needMB,
        message: `${MSG.diskLowPrefix}${needMB} MB${MSG.diskLowSuffix}`,
      };
    }
  } catch {
    // 某些系统没有 statfs，放过由编码阶段处理盘满。
  }
  return { ok: true };
}
