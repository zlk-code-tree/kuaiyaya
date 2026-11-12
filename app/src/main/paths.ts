import { app } from "electron";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface AppConfig {
  apiBaseUrl: string;
}

const DEFAULT_API = "http://127.0.0.1:8080";

export function defaultConfig(): AppConfig {
  return { apiBaseUrl: process.env.KUAIYAYA_API_BASE || DEFAULT_API };
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
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (app.isPackaged && resources) {
    return join(resources, "assets", "feedback-wechat-qr.png");
  }
  return join(app.getAppPath(), "resources", "assets", "feedback-wechat-qr.png");
}
