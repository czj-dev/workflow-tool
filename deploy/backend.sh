#!/usr/bin/env bash
# 后端构建：生成 bindings → 编译单二进制
#   Windows：-H windowsgui 隐藏控制台；编译前释放占用中的 exe
#   macOS / Linux：普通二进制
# 用法：bash build/backend.sh   （需 frontend/dist 已就绪）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND="$ROOT/frontend"

# 平台判定（Git Bash 报 MINGW*/MSYS*）
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;;
  Darwin|Linux)         IS_WIN=0 ;;
  *) echo "✗ 未知平台：$(uname -s)" >&2; exit 1 ;;
esac

# bindings：解析 api.go 生成前端绑定；改 api.go 方法签名/类型后必须重跑
if ! command -v wails3 >/dev/null 2>&1; then
  echo "✗ 未找到 wails3 CLI" >&2
  echo "  安装：go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.119" >&2
  exit 1
fi
echo "→ 生成 bindings…"
( cd "$ROOT" && wails3 generate bindings )

# dist 必须就绪（embed 进二进制）
if [ ! -d "$FRONTEND/dist" ]; then
  echo "✗ frontend/dist 缺失，请先跑 build/frontend.sh" >&2
  exit 1
fi

if [ "$IS_WIN" = "1" ]; then
  OUT="workflow-tool.exe"
  taskkill //IM "$OUT" //F 2>/dev/null || true   # 释放占用，否则 go build 写不进
  echo "→ 编译后端（Windows，隐藏控制台）→ $OUT"
  ( cd "$ROOT" && go build -ldflags "-H windowsgui" -o "$OUT" . )
else
  OUT="workflow-tool"
  echo "→ 编译后端 → $OUT"
  ( cd "$ROOT" && go build -o "$OUT" . )
fi
echo "✓ 后端完成 → $ROOT/$OUT"
