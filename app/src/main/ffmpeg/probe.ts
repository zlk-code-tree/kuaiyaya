import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, extname } from "node:path";
import { stat } from "node:fs/promises";
import type { ProbeInfo } from "../../shared/types";
import { displaySize } from "../../shared/scale";

const execFileAsync = promisify(execFile);

const EXT_OK = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);

export function isLikelyVideoPath(filePath: string): boolean {
  return EXT_OK.has(extname(filePath).toLowerCase());
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
    tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number | string; side_data_type?: string }>;
  }>;
}

function rotationOf(stream: NonNullable<FfprobeJson["streams"]>[number]): number {
  const tag = stream.tags?.rotate;
  if (tag && Number.isFinite(Number(tag))) return Number(tag);
  const side = stream.side_data_list?.find((s) => s.rotation != null);
  if (side && Number.isFinite(Number(side.rotation))) return Number(side.rotation);
  return 0;
}

export async function probeFile(ffprobe: string, filePath: string): Promise<ProbeInfo> {
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout) as FfprobeJson;
  const video = data.streams?.find((s) => s.codec_type === "video");
  if (!video || !video.width || !video.height) {
    throw new Error("unsupported");
  }
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(video.duration ?? data.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("unsupported");
  }
  const st = await stat(filePath);
  const rot = rotationOf(video);
  const display = displaySize(video.width, video.height, rot);
  return {
    path: filePath,
    name: basename(filePath),
    sizeBytes: st.size,
    durationSec: duration,
    width: video.width,
    height: video.height,
    rotation: rot,
    displayWidth: display.width,
    displayHeight: display.height,
    videoCodec: video.codec_name ?? "unknown",
    hasAudio: Boolean(audio),
    container: data.format?.format_name ?? extname(filePath).slice(1),
  };
}
