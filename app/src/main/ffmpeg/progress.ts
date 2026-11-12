/** 解析 ffmpeg -progress 管道。 */

export function parseProgressLine(line: string): { outTimeUs?: number; done?: boolean } {
  const trimmed = line.trim();
  if (!trimmed) return {};
  const eq = trimmed.indexOf("=");
  if (eq < 0) return {};
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (key === "out_time_us" || key === "out_time_ms" || key === "out_time_ns") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return {};
    const us = key === "out_time_ns" ? n / 1000 : key === "out_time_ms" ? n * 1000 : n;
    return { outTimeUs: us };
  }
  if (key === "out_time") {
    const us = parseClockToUs(value);
    if (us == null) return {};
    return { outTimeUs: us };
  }
  if (key === "progress" && value === "end") {
    return { done: true };
  }
  return {};
}

/** 解析 `out_time=HH:MM:SS.microseconds`。 */
export function parseClockToUs(value: string): number | undefined {
  const m = value.trim().match(/^(-?\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return undefined;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (![hours, minutes, seconds].every(Number.isFinite) || hours < 0) return undefined;
  return (hours * 3600 + minutes * 60 + seconds) * 1_000_000;
}

export function ratioFromOutTime(outTimeUs: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.min(1, Math.max(0, outTimeUs / 1_000_000 / durationSec));
}

export function etaSeconds(ratio: number, elapsedMs: number): number | null {
  if (ratio < 0.03 || elapsedMs < 800) return null;
  const remaining = elapsedMs * (1 / ratio - 1);
  return Math.max(0, Math.round(remaining / 1000));
}
