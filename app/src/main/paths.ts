import { app } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { defaultApiBaseUrl } from "../shared/api-config";

export interface AppConfig {
  apiBaseUrl: string;
}

export function defaultConfig(): AppConfig {
  return { apiBaseUrl: defaultApiBaseUrl(process.platform, process.env.KUAIYAYA_API_BASE) };
}

export async function loadConfig(): Promise<AppConfig> {
  const fallback = defaultConfig();
  try {
    const dir = app.getPath("userData");
    const file = join(dir, "config.json");
    if (!existsSync(file)) return fallback;
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<AppConfig>;
    return {
      apiBaseUrl: String(raw.apiBaseUrl ?? fallback.apiBaseUrl),
    };
  } catch {
    return fallback;
  }
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  const dir = app.getPath("userData");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

export function qrPath(): string {
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (app.isPackaged && resources) {
    candidates.push(join(resources, "assets", "feedback-wechat-qr.png"));
  }
  try {
    candidates.push(join(dirname(fileURLToPath(import.meta.url)), "../../resources/assets/feedback-wechat-qr.png"));
  } catch {
    /* ignore */
  }
  candidates.push(join(app.getAppPath(), "resources", "assets", "feedback-wechat-qr.png"));
  return candidates.find((item) => existsSync(item)) ?? candidates[candidates.length - 1]!;
}
