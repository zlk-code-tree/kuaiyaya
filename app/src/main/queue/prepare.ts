import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isTargetTooLarge } from "../../shared/bitrate";
import { MSG } from "../../shared/messages";
import { isLikelyVideoPath } from "../../shared/video-ext";
import { checkGuards } from "../fs/guard";
import { probeFile } from "../ffmpeg/probe";
import type { PrepareResult } from "./runner";

export async function prepareQueueItem(
  ffmpeg: () => Promise<{ ffmpeg: string; ffprobe: string }>,
  item: { filePath: string; targetMB: number | null; outputDirectory?: string | null },
): Promise<PrepareResult> {
  if (!isLikelyVideoPath(item.filePath) || !existsSync(item.filePath)) {
    return { ok: false, status: "failed", message: MSG.queueUnreadable };
  }
  try {
    const bins = await ffmpeg();
    const info = await probeFile(bins.ffprobe, item.filePath);
    const file = await stat(info.path);
    if (file.size !== info.sizeBytes) {
      return { ok: false, status: "failed", message: "视频文件已发生变化，请重新选择。" };
    }
    if (item.targetMB == null || !isTargetTooLarge(item.targetMB, info.sizeBytes)) {
      const guard = await checkGuards(info, item.targetMB, item.outputDirectory);
      if (!guard.ok && guard.reason !== "target_too_large") {
        return { ok: false, status: "failed", message: guard.message ?? MSG.encodeFail };
      }
    }
    return { ok: true, probe: info };
  } catch {
    return { ok: false, status: "failed", message: MSG.queueUnreadable };
  }
}
