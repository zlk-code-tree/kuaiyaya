export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

export function toast(text: string): void {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 1800);
}

export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(2)} MB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}小时${m % 60}分`;
  }
  if (m > 0) return `${m}分${r.toString().padStart(2, "0")}秒`;
  return `${r}秒`;
}

export function formatEta(sec: number | null, percent?: number): string {
  if (sec == null) return "计算预计时间…";
  // 进度很低时即使估出很短剩余时间，也不提示「即将完成」
  if (sec < 5 && (percent == null || percent >= 95)) return "即将完成";
  if (sec < 5) return "计算预计时间…";
  return `预计剩余 ${formatDuration(sec)}`;
}

export function formatRemainDetail(elapsedSec: number, etaSec: number | null, percent?: number): string {
  const remain = formatEta(etaSec, percent);
  if (etaSec == null || etaSec < 5) return remain;
  const total = Math.max(0, elapsedSec) + etaSec;
  return `${remain}（共约 ${formatDuration(total)}）`;
}

export function formatElapsed(elapsedSec: number): string {
  return `已用 ${formatDuration(Math.max(0, elapsedSec))}`;
}
