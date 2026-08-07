# 应用图标

侧边栏 header 的品牌图标（琥珀圆角块 + 白色闪电），用作 exe 文件图标（Windows）和窗口标题栏/任务栏图标。

## 文件

| 文件 | 用途 |
|---|---|
| `icon.svg` | 源矢量图（viewBox 24；琥珀 `#FCAA38` = 深色主题 primary `oklch(0.8 0.155 70)`；白色闪电 stroke 取自 hugeicons `FlashIcon`） |
| `icon.ico` | Windows 多尺寸 ico（256/128/64/48/32/16），透明背景 |
| `icon.png` | 512×512 PNG，被 [main.go](../main.go) embed 作 `application.Options.Icon`（窗口图标） |

## 嵌入机制

- **exe 文件图标**（资源管理器/任务栏大图）：`icon_windows.syso`（项目根），`go build` 在 Windows 自动链接（`_windows.syso` 平台后缀匹配）。由 rsrc 从 `icon.ico` 生成。
- **窗口标题栏/任务栏图标**（Windows/Linux）：`icon_other.go` `//go:embed assets/icon.png` → `application.Options.Icon` → Wails `webview_window_windows.go` 用 `CreateLargeHIconFromImage` 调 `WM_SETICON ICON_BIG`。
- **macOS Dock/访达图标**：走 `.app` bundle 的 `Contents/Resources/icon.icns`（`deploy/macos-app.sh` 现场生成，不入库）。
  `icon_darwin.go` 里 `appIcon` **必须留 nil**——Wails 启动时若 `options.Icon != nil` 会调 `[NSApp setApplicationIconImage:]`，用单张位图 `NSImage` 在运行期覆盖 bundle 图标，Dock 缩放插值就模糊了（表现为「访达清晰、Dock 模糊」）。

## SVG 光栅化必须用 rsvg-convert

**不要用 `magick -resize` 缩放 SVG。** ImageMagick 会先按 viewBox 原始尺寸（本图 24×24）光栅化，再把小位图**放大**到目标尺寸，边缘全是插值糊边——之前 Dock 图标模糊就是这个原因。

`rsvg-convert -w N -h N` 按目标尺寸直接矢量渲染，边缘锐利。magick 仅用于把已渲染好的多张 PNG 打包成 ico 容器（不做缩放）。

## 改图后重新生成

需 `rsvg-convert`（`brew install librsvg`）+ ImageMagick 7 + rsrc：

```bash
# 1. png + ico（脚本内部用 rsvg-convert 渲染，magick 仅打包 ico）
bash deploy/make-icons.sh

# 2. Windows exe 图标资源（rsrc；aliyun goproxy 需 GOSUMDB=off 绕过 sumdb 404）
GOSUMDB=off go run github.com/akavel/rsrc@latest -ico assets/icon.ico -o icon_windows.syso

# 3. 重建（macOS 再跑 macos-app.sh 打 .app）
bash deploy/build.sh
bash deploy/macos-app.sh   # 仅 macOS
```

改图后须重新生成 `icon_windows.syso` 并提交（它入库，避免每次构建依赖 rsrc）。

## macOS .app 打包

`deploy/macos-app.sh`：SVG → `.iconset`（16/32/128/256/512 各 @1x/@2x）→ `iconutil` 生成 `.icns`，拼 `WorkflowTool.app` bundle。运行时文件（`actions/`、`workflows/`、`config.yaml`、`fragments.yaml`）拷进 `Contents/MacOS/` 与二进制同级，`exeDir()` 逻辑无需改动。

首次打开若被 Gatekeeper 拦：`xattr -cr WorkflowTool.app` 或右键 → 打开。
