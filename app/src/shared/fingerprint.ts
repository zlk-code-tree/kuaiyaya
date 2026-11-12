import { createHash } from "node:crypto";
import { FINGERPRINT_SALT } from "./messages";

/**
 * v1 设备指纹。服务端只收 64 位小写 hex，不再加盐、不重算。
 * deviceId = SHA-256("kuaiyaya.v1" + "|" + hw_uuid + "|" + os_install_id)
 */
export function computeDeviceId(hwUuid: string, osInstallId: string): string {
  const material = `${FINGERPRINT_SALT}|${hwUuid}|${osInstallId}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function isDeviceId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
