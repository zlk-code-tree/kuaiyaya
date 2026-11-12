/** 纯字符串版，渲染进程也可调用（不依赖 node:path）。 */
export function suggestedOutputName(inputPath: string): string {
  const file = inputPath.split(/[/\\]/).pop() ?? "video";
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  return `${base}_1080p.mp4`;
}
