import { access, chmod, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BinaryPaths {
  ffmpeg: string;
  ffprobe: string;
  source: "env" | "bundled" | "system";
}

function bundledDir(platform = process.platform, arch = process.arch): string {
  const folder = `${platform}-${arch}`;
  if (process.env.KUAIYAYA_RESOURCES) {
    return join(process.env.KUAIYAYA_RESOURCES, "ffmpeg", folder);
  }
  // electron packaged
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources && !process.env.VITE_DEV_SERVER_URL && !process.env.ELECTRON_VITE_DEV) {
    return join(resources, "ffmpeg", folder);
  }
  // repo layout: app/resources/ffmpeg/<plat-arch>
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "resources", "ffmpeg", folder),
    join(process.cwd(), "app", "resources", "ffmpeg", folder),
    join(here, "../../resources/ffmpeg", folder),
    join(here, "../../../resources/ffmpeg", folder),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "ffmpeg")) || existsSync(join(c, "ffmpeg.exe"))) return c;
  }
  return candidates[0];
}

async function isExec(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    try {
      await chmod(p, 0o755);
      await access(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveBinaries(): Promise<BinaryPaths> {
  const envFfmpeg = process.env.KUAIYAYA_FFMPEG ?? process.env.FFMPEG_PATH;
  const envFfprobe = process.env.KUAIYAYA_FFPROBE ?? process.env.FFPROBE_PATH;
  if (envFfmpeg && envFfprobe && (await isExec(envFfmpeg)) && (await isExec(envFfprobe))) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: "env" };
  }

  const dir = bundledDir();
  const ffmpeg = join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobe = join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (existsSync(ffmpeg) && existsSync(ffprobe) && (await isExec(ffmpeg)) && (await isExec(ffprobe))) {
    return { ffmpeg, ffprobe, source: "bundled" };
  }

  // 开发机回退：系统 ffmpeg（正式包不得依赖系统安装）
  const sysFfmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const sysFfprobe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return { ffmpeg: sysFfmpeg, ffprobe: sysFfprobe, source: "system" };
}
