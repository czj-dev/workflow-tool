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
- **窗口标题栏/任务栏图标**：`main.go` `//go:embed assets/icon.png` → `application.Options.Icon` → Wails `webview_window_windows.go` 用 `CreateLargeHIconFromImage` 调 `WM_SETICON ICON_BIG`。这是跨平台字段（Linux 后端也读 `options.Icon`）。

## 改图后重新生成

需 ImageMagick 7（`magick`）+ rsrc：

```bash
# 1. SVG → ico(多尺寸,透明) + png(窗口图标源)
magick -background none assets/icon.svg -define icon:auto-resize=256,128,64,48,32,16 assets/icon.ico
magick -background none assets/icon.svg -resize 512x512 assets/icon.png

# 2. Windows exe 图标资源(rsrc；aliyun goproxy 需 GOSUMDB=off 绕过 sumdb 404)
GOSUMDB=off go run github.com/akavel/rsrc@latest -ico assets/icon.ico -o icon_windows.syso

# 3. 重建
bash deploy/build.sh
```

改图后须重新生成 `icon_windows.syso` 并提交（它入库，避免每次构建依赖 rsrc）。

## Mac（暂未配置）

`.icns` 需 `png2icons` 或 Mac `iconutil`，`.app` 打包需 Wails mac build —— 当前只 `go build` 裸二进制，暂不考虑。
