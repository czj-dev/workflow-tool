#!/usr/bin/env bash
# macOS .app 打包：SVG → 多分辨率 .icns，生成 WorkflowTool.app bundle
#   Dock/访达/Cmd+Tab 图标锐利（.icns 多分辨率层，系统按尺寸选层不插值）
#   裸二进制单 PNG 走 NSImage 会被缩放插值发虚——bundle 是唯一解
# 用法：bash deploy/macos-app.sh   （需先跑 build.sh 产出 workflow-tool 二进制）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

[ "$(uname -s)" = "Darwin" ] || { echo "✗ 仅 macOS 可用" >&2; exit 1; }
command -v rsvg-convert >/dev/null || { echo "✗ 需 rsvg-convert（brew install librsvg）" >&2; exit 1; }
command -v iconutil     >/dev/null || { echo "✗ 需 iconutil（macOS 自带）" >&2; exit 1; }

BIN="$ROOT/workflow-tool"
[ -f "$BIN" ] || { echo "✗ 缺 workflow-tool 二进制，请先 bash deploy/build.sh" >&2; exit 1; }

APP="$ROOT/WorkflowTool.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

echo "→ 清理旧 bundle"
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"

echo "→ SVG → .icns（多分辨率 16..1024）"
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for sz in 16 32 128 256 512; do
  rsvg-convert -w "$sz"       -h "$sz"       "$ROOT/assets/icon.svg" -o "$ICONSET/icon_${sz}x${sz}.png"
  rsvg-convert -w "$((sz*2))" -h "$((sz*2))" "$ROOT/assets/icon.svg" -o "$ICONSET/icon_${sz}x${sz}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$RES/icon.icns"
rm -rf "$(dirname "$ICONSET")"

echo "→ 拷贝二进制 + 运行时文件到 Contents/MacOS（exeDir 读二进制同级）"
cp "$BIN" "$MACOS/workflow-tool"
cp -R "$ROOT/actions"   "$MACOS/actions"
cp -R "$ROOT/workflows" "$MACOS/workflows"
cp "$ROOT/config.yaml"    "$MACOS/config.yaml"
cp "$ROOT/fragments.yaml" "$MACOS/fragments.yaml"

echo "→ 写 Info.plist"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Workflow Tool</string>
  <key>CFBundleDisplayName</key>     <string>Workflow Tool</string>
  <key>CFBundleExecutable</key>      <string>workflow-tool</string>
  <key>CFBundleIdentifier</key>      <string>com.workflow-tool.app</string>
  <key>CFBundleIconFile</key>        <string>icon</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>CFBundleShortVersionString</key> <string>1.0.0</string>
  <key>CFBundleVersion</key>         <string>1</string>
  <key>LSMinimumSystemVersion</key>  <string>10.13</string>
  <key>NSHighResolutionCapable</key> <true/>
</dict>
</plist>
PLIST

echo "✓ 打包完成 → $APP"
echo "  首次打开若被 Gatekeeper 拦：右键 → 打开，或 xattr -cr \"$APP\""
