package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"workflow-tool/internal/api"
	"workflow-tool/internal/apphome"
	"workflow-tool/internal/cli"
	"workflow-tool/internal/registry"
	"workflow-tool/internal/runner"
	"workflow-tool/internal/workflow"

	// adb 域子包各自在 init() 中调用 adb.RegisterOperation 自登记 operation。
	// 必须在此 blank import，否则未引用的子包不会编译进二进制、init() 不执行、operation 表为空。
	_ "workflow-tool/internal/adb/file"
	_ "workflow-tool/internal/adb/foreground"
	_ "workflow-tool/internal/adb/input"
	_ "workflow-tool/internal/adb/logcat"
	_ "workflow-tool/internal/adb/package"
	_ "workflow-tool/internal/adb/scrcpy"
)

//go:embed all:frontend/dist
var assets embed.FS

// appIcon 在 icon_darwin.go / icon_other.go 中按平台定义。
// macOS 留 nil，避免 [NSApp setApplicationIconImage:] 用单张位图覆盖 bundle 的 .icns 多分辨率图标。

func main() {
	// darwin GUI 启动的 .app 由 launchd 派生，PATH 极简（无 /usr/local/bin、homebrew、
	// Android SDK 等），adb/claude/gradlew 依赖的 java 会全部 command not found。
	// 抓真实登录 shell PATH 合并进来，非 darwin 空操作。
	runner.FixPath()

	// headless 子命令分流：命中 list/describe/run 走 CLI（供 Agent shell 调用），
	// 否则照旧起 GUI。adb 子包的 operation 自登记已在上方 blank import 的 init() 完成。
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "list", "describe", "run":
			os.Exit(cli.Run(os.Args[1:]))
		}
	}

	baseDir := apphome.ExeDir()
	reg := registry.Load(filepath.Join(baseDir, "actions"), baseDir)
	wfReg := workflow.Load(filepath.Join(baseDir, "workflows"))
	svc := api.New(reg, wfReg, baseDir, filepath.Join(baseDir, "config.yaml"), filepath.Join(baseDir, "fragments.yaml"))

	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "Workflow Tool",
		Description: "一键触发命令/脚本的 workflow 工具",
		Icon:        appIcon,
		Services: []application.Service{
			application.NewService(svc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(distFS),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	svc.SetApp(app)

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          "Workflow Tool",
		Width:          900,
		Height:         640,
		URL:            "/",
		EnableFileDrop: true,
	})

	// 整窗口拖拽落地路径：全部路径 + 松手坐标转发给前端，由前端按坐标定位目标输入框
	// 写入（见 frontend/src/lib/filedrop.ts）。
	// 前提：frontend/index.html 的 body 必须带 data-file-drop-target——Wails 用
	// elementFromPoint(x,y).closest('[data-file-drop-target]') 找落点，祖先没有这个属性时
	// 事件根本不会发到 Go，且完全静默。删掉它整个拖拽功能失效且无从排查。
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		ctx := event.Context()
		files := ctx.DroppedFiles()
		if len(files) == 0 {
			return
		}
		payload := map[string]any{"paths": files}
		// 坐标随命中信息一起来；理论上必有，判空只为不 panic（缺坐标时前端自然忽略本次拖拽）
		if d := ctx.DropTargetDetails(); d != nil {
			payload["x"] = d.X
			payload["y"] = d.Y
		}
		app.Event.Emit("file:dropped", payload)
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
