#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/app/resources/ffmpeg/win32-x64"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"
curl -fsSL https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz -o "$TMP/ffmpeg.tgz"
curl -fsSL https://registry.npmjs.org/@ffprobe-installer/win32-x64/-/win32-x64-5.1.0.tgz -o "$TMP/ffprobe.tgz"
printf '%s  %s\n' 2aa313be3585994d710197bc4196f5fcbb6a1469be1013b24d200e45d773592f "$TMP/ffmpeg.tgz" 97992b5e3b651c7df625831fd369eecc5ec0e9532ac98921138b1c4fbc8de96e "$TMP/ffprobe.tgz" | shasum -a 256 -c
tar -xzf "$TMP/ffmpeg.tgz" -C "$DEST" --strip-components=1 package/ffmpeg.exe
tar -xzf "$TMP/ffprobe.tgz" -C "$DEST" --strip-components=1 package/ffprobe.exe
