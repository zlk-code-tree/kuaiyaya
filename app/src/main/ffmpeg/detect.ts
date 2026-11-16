import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncoderCaps } from "../../shared/types";

const execFileAsync = promisify(execFile);

export async function listEncoders(ffmpeg: string): Promise<{ x265: boolean; videotoolbox: boolean; version: string }> {
  const { stdout, stderr } = await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"], {
    timeout: 15_000,
  });
  const text = `${stdout}\n${stderr}`;
  let version = "";
  try {
    const v = await execFileAsync(ffmpeg, ["-hide_banner", "-version"], { timeout: 10_000 });
    version = (v.stdout || v.stderr).split("\n")[0]?.trim() ?? "";
  } catch {
    version = "unknown";
  }
  return {
    x265: /\slibx265\s/.test(text) || text.includes("libx265"),
    videotoolbox: text.includes("hevc_videotoolbox"),
    version,
  };
}

/** 仅在声明支持 VideoToolbox 时试编 1 帧，确认进程能以 0 退出。Linux 上不会走到这里。 */
export async function probeVideoToolbox(ffmpeg: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-vt-"));
  const src = join(dir, "in.mp4");
  const out = join(dir, "out.mp4");
  try {
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=0.2",
        "-c:v",
        "libx264",
        "-t",
        "0.2",
        src,
      ],
      { timeout: 20_000 },
    );
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner",
        "-y",
        "-i",
        src,
        "-c:v",
        "hevc_videotoolbox",
        "-b:v",
        "200k",
        "-allow_sw",
        "0",
        "-t",
        "0.2",
        "-tag:v",
        "hvc1",
        out,
      ],
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function detectCaps(ffmpeg: string): Promise<EncoderCaps> {
  const listed = await listEncoders(ffmpeg);
  let videotoolbox = listed.videotoolbox;
  if (videotoolbox) {
    videotoolbox = await probeVideoToolbox(ffmpeg);
  }
  return {
    x265: listed.x265,
    videotoolbox,
    ffmpegVersion: listed.version,
    probedAt: new Date().toISOString(),
    ffmpegPath: ffmpeg,
  };
}
