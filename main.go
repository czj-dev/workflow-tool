package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"

	"workflow-tool/internal/api"
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

	baseDir := exeDir()
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

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Workflow Tool",
		Width:  900,
		Height: 640,
		URL:    "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// exeDir 返回 exe 所在目录；dev 模式回退到当前工作目录。
func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "actions")); err != nil {
		return "." // dev 时 actions/ 在项目根
	}
	return dir
}
