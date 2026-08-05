#!/usr/bin/env bash
# 全量构建：前端 → 后端（bindings + 单二进制）
# 用法：bash build/build.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==== [1/2] 前端 ===="
bash "$SCRIPT_DIR/frontend.sh"
echo
echo "==== [2/2] 后端 ===="
bash "$SCRIPT_DIR/backend.sh"
echo
echo "✓ 全量构建完成"
