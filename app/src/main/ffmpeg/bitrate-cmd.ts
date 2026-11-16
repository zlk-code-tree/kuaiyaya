import type { EncoderKind, ProbeInfo } from "../../shared/types";
import { videoBitrateBps, type BitrateInput } from "../../shared/bitrate";
import { displaySize, scaleFilter } from "../../shared/scale";

export interface CommandPlan {
  encoder: EncoderKind;
  videoBitrateBps: number;
  args: string[][];
  passLog?: string;
}

export function buildCommands(opts: {
  encoder: EncoderKind;
  ffmpegPath: string;
  input: string;
  output: string;
  probe: ProbeInfo;
  targetBytes: number;
  videoBps?: number;
  passLog?: string;
  nullSink?: string;
  /** quality：默认压缩，只按清晰度压一轮。bitrate：试压按目标码率比较，保持两遍 ABR。 */
  mode?: "quality" | "bitrate";
}): CommandPlan {
  const mode = opts.mode ?? "quality";
  const display = displaySize(opts.probe.width, opts.probe.height, opts.probe.rotation);
  const vf = scaleFilter(display);
  const bps =
    opts.videoBps ??
    videoBitrateBps({
      targetBytes: opts.targetBytes,
      durationSec: opts.probe.durationSec,
      hasAudio: opts.probe.hasAudio,
    } satisfies BitrateInput);
  const commonIn = ["-hide_banner", "-y", "-i", opts.input, "-map", "0:v:0"];
  const audio = opts.probe.hasAudio
    ? (["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"] as string[])
    : (["-an"] as string[]);
  const mux = ["-tag:v", "hvc1", "-movflags", "+faststart"];
  const progress = ["-progress", "pipe:1", "-nostats"];

  if (opts.encoder === "x265") {
    if (mode === "bitrate") {
      // 两遍 ABR 锁定平均体积，放宽 VBV 峰值让复杂画面有 bit 可用。仅试压走这条路径。
      const maxrate = Math.floor(bps * 1.5);
      const bufsize = Math.floor(bps * 3);
      const passLog = opts.passLog ?? `${opts.output}.x265pass`;
      const nullSink = opts.nullSink ?? (process.platform === "win32" ? "NUL" : "/dev/null");
      const pass1 = [
        ...commonIn,
        "-an",
        "-c:v",
        "libx265",
        "-b:v",
        String(bps),
        "-maxrate",
        String(maxrate),
        "-bufsize",
        String(bufsize),
        // 第一遍只做统计分析，用 veryfast 换速度；画质由第二遍决定。
        "-preset",
        "veryfast",
        "-vf",
        vf,
        "-pass",
        "1",
        "-passlogfile",
        passLog,
        "-f",
        "mp4",
        ...progress,
        nullSink,
      ];
      const pass2 = [
        ...commonIn,
        "-c:v",
        "libx265",
        "-b:v",
        String(bps),
        "-maxrate",
        String(maxrate),
        "-bufsize",
        String(bufsize),
        "-preset",
        "fast",
        "-vf",
        vf,
        ...audio,
        ...mux,
        "-pass",
        "2",
        "-passlogfile",
        passLog,
        "-f",
        "mp4",
        ...progress,
        opts.output,
      ];
      return { encoder: "x265", videoBitrateBps: bps, args: [pass1, pass2], passLog };
    }

    // 清晰度优先：对齐两遍编码第二遍的 fast + 较高画质，只压一轮，不再追目标体积。
    const single = [
      ...commonIn,
      "-c:v",
      "libx265",
      "-crf",
      "20",
      "-preset",
      "fast",
      "-vf",
      vf,
      ...audio,
      ...mux,
      "-f",
      "mp4",
      ...progress,
      opts.output,
    ];
    return { encoder: "x265", videoBitrateBps: bps, args: [single] };
  }

  if (mode === "bitrate") {
    // 硬编单遍，VBV 保持收紧以贴近目标体积；关掉速度优先、打开空间自适应量化换画质，
    // 禁止静默退回 VideoToolbox 软编（软编回退由 job 层改走 libx265）。
    const maxrate = Math.floor(bps * 1.1);
    const bufsize = Math.floor(bps * 2);
    const single = [
      ...commonIn,
      "-c:v",
      "hevc_videotoolbox",
      "-b:v",
      String(bps),
      "-maxrate",
      String(maxrate),
      "-bufsize",
      String(bufsize),
      "-allow_sw",
      "0",
      "-prio_speed",
      "0",
      "-spatial_aq",
      "1",
      "-vf",
      vf,
      ...audio,
      ...mux,
      "-f",
      "mp4",
      ...progress,
      opts.output,
    ];
    return { encoder: "videotoolbox", videoBitrateBps: bps, args: [single] };
  }

  // 清晰度优先硬编：用恒定质量，不再用目标码率收体积。速度优先仍关闭，禁止静默退回软编。
  const quality = [
    ...commonIn,
    "-c:v",
    "hevc_videotoolbox",
    "-q:v",
    "70",
    "-allow_sw",
    "0",
    "-prio_speed",
    "0",
    "-spatial_aq",
    "1",
    "-vf",
    vf,
    ...audio,
    ...mux,
    "-f",
    "mp4",
    ...progress,
    opts.output,
  ];
  return { encoder: "videotoolbox", videoBitrateBps: bps, args: [quality] };
}
