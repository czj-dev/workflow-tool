#!/usr/bin/env bash
# 前端构建：bindings（缺则自动生成）→ 依赖（缺则安装）→ 产出 frontend/dist/
# 用法：bash build/frontend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$ROOT/frontend"

# 前端代码 import frontend/bindings（gitignored 产物），缺失则用 wails3 生成
if [ ! -d "$FRONTEND/bindings" ]; then
  if command -v wails3 >/dev/null 2>&1; then
    echo "→ frontend/bindings 缺失，生成中…"
    ( cd "$ROOT" && wails3 generate bindings )
  else
    echo "✗ frontend/bindings 缺失，且未安装 wails3 CLI" >&2
    echo "  安装：go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119" >&2
    exit 1
  fi
fi

cd "$FRONTEND"
if [ ! -d node_modules ]; then
  echo "→ 安装前端依赖…"
  npm install
fi
echo "→ 前端构建（npm run build）…"
npm run build
echo "✓ 前端完成 → $FRONTEND/dist"
