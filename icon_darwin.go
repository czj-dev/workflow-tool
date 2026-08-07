//go:build darwin

package main

// macOS Dock/访达图标走 .app bundle 的 Resources/icon.icns（多分辨率层，系统按尺寸选层不插值）。
// 这里必须留 nil：Wails 启动时若 options.Icon != nil 会调 [NSApp setApplicationIconImage:]，
// 用单张位图 NSImage 运行时覆盖 bundle 图标 → Dock 缩放插值发虚。
// 打包见 deploy/macos-app.sh。
var appIcon []byte
