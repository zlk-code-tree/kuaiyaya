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
}): CommandPlan {
  const display = displaySize(opts.probe.width, opts.probe.height, opts.probe.rotation);
  const vf = scaleFilter(display);
  const bps =
    opts.videoBps ??
    videoBitrateBps({
      targetBytes: opts.targetBytes,
      durationSec: opts.probe.durationSec,
      hasAudio: opts.probe.hasAudio,
    } satisfies BitrateInput);
  const maxrate = Math.floor(bps * 1.1);
  const bufsize = Math.floor(bps * 2);
  const commonIn = ["-hide_banner", "-y", "-i", opts.input, "-map", "0:v:0"];
  const audio = opts.probe.hasAudio
    ? (["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k"] as string[])
    : (["-an"] as string[]);
  const mux = ["-tag:v", "hvc1", "-movflags", "+faststart"];
  const progress = ["-progress", "pipe:1", "-nostats"];

  if (opts.encoder === "x265") {
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
      "-preset",
      "fast",
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
