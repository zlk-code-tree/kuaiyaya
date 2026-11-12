#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== Go tests =="
(cd "$ROOT/server" && go test ./... && go build -o /tmp/kuaiyaya-keyserver ./cmd/keyserver)
echo "== Electron typecheck / lint / unit tests =="
(cd "$ROOT/app" && npm test && npm run typecheck && npm run lint)
echo "all ok"
