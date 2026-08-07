#!/usr/bin/env bash
# 从 assets/icon.svg 重生成所有平台图标产物（入库，避免每次构建依赖渲染工具）。
#
# 关键：SVG 光栅化必须用 rsvg-convert 按目标尺寸直接矢量渲染。
# 不要用 `magick -resize`——它先按 viewBox 原始尺寸（24×24）光栅化再放大位图，
# 边缘插值糊边，Dock/任务栏显示明显模糊。magick 在此只用于把已渲染好的
# 多张 PNG 打包成 ico 容器（不做缩放）。
#
# 用法：bash deploy/make-icons.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG="$ROOT/assets/icon.svg"

command -v rsvg-convert >/dev/null || { echo "✗ 需 rsvg-convert（brew install librsvg）" >&2; exit 1; }
command -v magick       >/dev/null || { echo "✗ 需 ImageMagick 7（brew install imagemagick）" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ icon.png（512，Linux/Windows 窗口图标源）"
rsvg-convert -w 512 -h 512 "$SVG" -o "$ROOT/assets/icon.png"

echo "→ icon.ico（Windows 多尺寸 16..256）"
for sz in 16 32 48 64 128 256; do
  rsvg-convert -w "$sz" -h "$sz" "$SVG" -o "$TMP/ico_$sz.png"
done
magick "$TMP"/ico_16.png "$TMP"/ico_32.png "$TMP"/ico_48.png \
       "$TMP"/ico_64.png "$TMP"/ico_128.png "$TMP"/ico_256.png "$ROOT/assets/icon.ico"

echo "✓ 完成。Windows exe 图标资源还需重新生成并提交 icon_windows.syso："
echo "  GOSUMDB=off go run github.com/akavel/rsrc@latest -ico assets/icon.ico -o icon_windows.syso"
echo "  macOS .app 图标由 deploy/macos-app.sh 现场生成 .icns，无需入库产物。"
