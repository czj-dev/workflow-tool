#!/usr/bin/env bash
# 前端构建：bindings（总是重新生成，确保与 api.go 同步）→ 依赖（缺则安装）→ 产出 frontend/dist/
# 用法：bash build/frontend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$ROOT/frontend"

# 前端代码 import frontend/bindings（gitignored 产物）。
# 总是重新生成：改 api.go 后 method ID 会变，前端必须用最新 bindings 构建，
# 否则运行时报 "method ID not found"。顺序铁律：bindings → npm build → go build。
if ! command -v wails3 >/dev/null 2>&1; then
  echo "✗ 未安装 wails3 CLI，无法生成 bindings" >&2
  echo "  安装：go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119" >&2
  exit 1
fi
echo "→ 生成 frontend/bindings…"
( cd "$ROOT" && wails3 generate bindings )

cd "$FRONTEND"
if [ ! -d node_modules ]; then
  echo "→ 安装前端依赖…"
  npm install
fi
echo "→ 前端构建（npm run build）…"
npm run build
echo "✓ 前端完成 → $FRONTEND/dist"
