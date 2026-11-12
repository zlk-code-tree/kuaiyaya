import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KEYCHAIN_SERVICE } from "../../shared/messages";

const execFileAsync = promisify(execFile);

const ACCOUNT_KEY = "license-key";
const ACCOUNT_DEVICE = "device-id";

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  del(account: string): Promise<void>;
}

/** macOS 钥匙串。Linux 上不可用，测试和开发注入 MemorySecretStore。 */
export class KeychainStore implements SecretStore {
  constructor(private readonly service = KEYCHAIN_SERVICE) {}

  async get(account: string): Promise<string | null> {
    if (process.platform !== "darwin") return null;
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w",
      ]);
      const value = stdout.replace(/\n$/, "");
      return value || null;
    } catch {
      return null;
    }
  }

  async set(account: string, value: string): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("钥匙串仅在 macOS 上可用");
    }
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      account,
      "-w",
      value,
    ]);
  }

  async del(account: string): Promise<void> {
    if (process.platform !== "darwin") return;
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        account,
      ]);
    } catch {
      // already gone
    }
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly data = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.data.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    this.data.set(account, value);
  }
  async del(account: string): Promise<void> {
    this.data.delete(account);
  }
}

/** Windows DPAPI 保护的本地密钥，仅可由当前 Windows 用户解密。 */
export class WindowsSecretStore implements SecretStore {
  private path(account: string): string {
    if (account !== ACCOUNT_KEY && account !== ACCOUNT_DEVICE) throw new Error("无效的密钥账户");
    return join(app.getPath("userData"), "secrets", `${account}.bin`);
  }
  async get(account: string): Promise<string | null> {
    try {
      const encrypted = await readFile(this.path(account));
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 密钥保护不可用");
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async set(account: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 密钥保护不可用");
    const path = this.path(account);
    await mkdir(join(app.getPath("userData"), "secrets"), { recursive: true });
    await writeFile(path, safeStorage.encryptString(value));
  }
  async del(account: string): Promise<void> {
    await rm(this.path(account), { force: true });
  }
}

export async function readStoredKey(store: SecretStore): Promise<string | null> {
  return store.get(ACCOUNT_KEY);
}

export async function writeStoredKey(store: SecretStore, key: string, deviceId: string): Promise<void> {
  await store.set(ACCOUNT_KEY, key);
  await store.set(ACCOUNT_DEVICE, deviceId);
}

export async function clearStoredKey(store: SecretStore): Promise<void> {
  await store.del(ACCOUNT_KEY);
  await store.del(ACCOUNT_DEVICE);
}
