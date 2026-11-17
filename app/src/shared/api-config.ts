/** macOS 和 Windows 正式版默认使用云端 Key 服务。 */
export const CLOUD_API = "http://8.140.245.64/kuaiyaya";
export const LOCAL_API = "http://127.0.0.1:8080";

export function defaultApiBaseUrl(platform: string, override?: string): string {
  return override || (platform === "win32" || platform === "darwin" ? CLOUD_API : LOCAL_API);
}
