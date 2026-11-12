/** 长边不超过 1920（即最高 1080p）、不放大、保持比例、宽高做成偶数。尊重旋转后的展示尺寸。 */

export const MAX_LONG_EDGE = 1920;

export interface Size {
  width: number;
  height: number;
}

export function displaySize(width: number, height: number, rotation: number): Size {
  const rot = ((rotation % 360) + 360) % 360;
  if (rot === 90 || rot === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

export function even(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r - 1;
}

/** 1080p 原片保持 1920×1080，4K 等更高分辨率缩到长边 1920，不放大。 */
export function fitOutput(display: Size): Size {
  const long = Math.max(display.width, display.height);
  if (long <= MAX_LONG_EDGE) {
    return { width: even(display.width), height: even(display.height) };
  }
  const scale = MAX_LONG_EDGE / long;
  return {
    width: even(display.width * scale),
    height: even(display.height * scale),
  };
}

export function outputLabel(display: Size): string {
  const out = fitOutput(display);
  return `${out.width}×${out.height}`;
}

/**
 * ffmpeg scale 滤镜：按展示尺寸限制长边 1920，不放大。
 * 旋转由 ffmpeg 的 autodisplay 处理时，输入已经是解码后画面；
 * 这里按探测得到的展示宽高计算目标。
 */
export function scaleFilter(display: Size): string {
  const target = fitOutput(display);
  const long = Math.max(display.width, display.height);
  if (long <= MAX_LONG_EDGE) {
    return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  }
  return `scale=${target.width}:${target.height}`;
}
