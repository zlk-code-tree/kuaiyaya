#!/usr/bin/env bash
# 为第一期 darwin-arm64 包准备随包 ffmpeg / ffprobe。
# 二进制不入库。优先复制本机已有的合格构建；也可指定下载地址。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/app/resources/ffmpeg/darwin-arm64"
mkdir -p "$DEST"

need_encoders() {
  local bin="$1"
  local list
  list="$("$bin" -hide_banner -encoders 2>/dev/null || true)"
  echo "$list" | grep -q "libx265" || return 1
  echo "$list" | grep -q "hevc_videotoolbox" || return 1
  return 0
}

copy_pair() {
  local ffmpeg="$1" ffprobe="$2"
  cp "$ffmpeg" "$DEST/ffmpeg"
  cp "$ffprobe" "$DEST/ffprobe"
  chmod +x "$DEST/ffmpeg" "$DEST/ffprobe"
  echo "已放入 $DEST"
  "$DEST/ffmpeg" -hide_banner -version | head -n 1
}

if [[ -n "${FFMPEG_BIN:-}" && -n "${FFPROBE_BIN:-}" ]]; then
  copy_pair "$FFMPEG_BIN" "$FFPROBE_BIN"
  need_encoders "$DEST/ffmpeg" || {
    echo "警告：指定的 ffmpeg 未同时包含 libx265 与 hevc_videotoolbox" >&2
    exit 1
  }
  exit 0
fi

if [[ -n "${FFMPEG_URL:-}" && -n "${FFPROBE_URL:-}" ]]; then
  curl -L --fail -o "$DEST/ffmpeg" "$FFMPEG_URL"
  curl -L --fail -o "$DEST/ffprobe" "$FFPROBE_URL"
  chmod +x "$DEST/ffmpeg" "$DEST/ffprobe"
  need_encoders "$DEST/ffmpeg" || {
    echo "警告：下载的 ffmpeg 未同时包含 libx265 与 hevc_videotoolbox" >&2
    exit 1
  }
  echo "已从 URL 下载到 $DEST"
  exit 0
fi

# 开发机：若 PATH 或 Homebrew 里已有合格二进制，直接复制。
CANDIDATES=()
if command -v ffmpeg >/dev/null 2>&1; then
  CANDIDATES+=("$(command -v ffmpeg)")
fi
if command -v brew >/dev/null 2>&1; then
  PREFIX="$(brew --prefix ffmpeg 2>/dev/null || true)"
  if [[ -n "$PREFIX" && -x "$PREFIX/bin/ffmpeg" ]]; then
    CANDIDATES+=("$PREFIX/bin/ffmpeg")
  fi
  OPT_PREFIX="$(brew --prefix 2>/dev/null || true)"
  if [[ -n "$OPT_PREFIX" && -x "$OPT_PREFIX/opt/ffmpeg/bin/ffmpeg" ]]; then
    CANDIDATES+=("$OPT_PREFIX/opt/ffmpeg/bin/ffmpeg")
  fi
fi

for bin in "${CANDIDATES[@]:-}"; do
  [[ -x "$bin" ]] || continue
  if need_encoders "$bin"; then
    probe="$(dirname "$bin")/ffprobe"
    if [[ ! -x "$probe" ]]; then
      probe="$(command -v ffprobe || true)"
    fi
    if [[ -x "$probe" ]]; then
      copy_pair "$bin" "$probe"
      exit 0
    fi
  fi
done

cat <<'HINT' >&2
没有找到同时包含 libx265 与 hevc_videotoolbox 的 ffmpeg。

在 Apple 芯片 Mac 上可以：
  1. brew install ffmpeg
     然后再次运行 ./scripts/fetch-ffmpeg.sh
  2. 或指定已有二进制：
     FFMPEG_BIN=/path/ffmpeg FFPROBE_BIN=/path/ffprobe ./scripts/fetch-ffmpeg.sh
  3. 或指定下载地址（须为 GPL 构建，编入 libx265 + VideoToolbox）：
     FFMPEG_URL=... FFPROBE_URL=... ./scripts/fetch-ffmpeg.sh

第一期正式包必须随包携带 ffmpeg，不能依赖用户机器上的系统安装。
HINT
exit 1
