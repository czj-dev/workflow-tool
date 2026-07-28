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
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	baseDir := exeDir()
	reg := registry.Load(filepath.Join(baseDir, "actions"), baseDir)
	svc := api.New(reg, baseDir)

	distFS, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "Workflow Tool",
		Description: "一键触发命令/脚本的 workflow 工具",
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
