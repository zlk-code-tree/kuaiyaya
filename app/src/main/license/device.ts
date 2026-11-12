import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { join } from "node:path";
import { computeDeviceId } from "../../shared/fingerprint";

const execFileAsync = promisify(execFile);

export async function readIOPlatformUUID(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("IOPlatformUUID 仅在 macOS 上可读取");
  }
  const { stdout } = await execFileAsync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("无法读取 IOPlatformUUID");
  return match[1];
}

export async function readVolumeUUID(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("系统卷 UUID 仅在 macOS 上可读取");
  }
  const { stdout } = await execFileAsync("diskutil", ["info", "/"]);
  const match = stdout.match(/Volume UUID:\s*([0-9A-F-]+)/i);
  if (!match) throw new Error("无法读取系统卷 Volume UUID");
  return match[1];
}

export async function currentDeviceId(): Promise<string> {
  if (process.platform === "win32") {
    const reg = join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
    const { stdout } = await execFileAsync(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
    const match = stdout.match(/MachineGuid\s+REG_\w+\s+([0-9a-f-]+)/i);
    if (!match) throw new Error("无法读取 Windows MachineGuid");
    return computeDeviceId(match[1].toLowerCase(), "windows-machine-guid");
  }
  const hw = await readIOPlatformUUID();
  const osInstall = await readVolumeUUID();
  return computeDeviceId(hw, osInstall);
}

export function deviceLabel(): string {
  return `${hostname()} (${process.platform} ${process.arch})`;
}
