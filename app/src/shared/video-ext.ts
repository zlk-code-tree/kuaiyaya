const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);

/** 与选择对话框的扩展名一致。不读文件内容。 */
export function isLikelyVideoPath(filePath: string): boolean {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  if (dot <= slash) return false;
  return VIDEO_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}
