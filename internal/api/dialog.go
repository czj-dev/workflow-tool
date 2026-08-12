package api

import "github.com/wailsapp/wails/v3/pkg/application"

// PickDirectory 打开原生目录选择对话框，返回选中目录（用户取消则返回空串）。
// 用 Wails v3 alpha2 的 OpenFileDialog builder 实现：CanChooseDirectories=true
// 时底层走 NewSelectFolderDialog。对话框难单测，靠联调验证。
func (s *Service) PickDirectory() (string, error) {
	dialog := (&application.OpenFileDialogStruct{}).
		SetTitle("选择目录").
		CanChooseDirectories(true).
		CanChooseFiles(false)
	return dialog.PromptForSingleSelection()
}

// PickFile 打开原生文件选择对话框，返回选中文件（用户取消则返回空串）。
// 与 PickDirectory 对称：CanChooseFiles=true、CanChooseDirectories=false，
// 用于 type: file 的参数（如 adb-push 的 LOCAL_PATH、adb-install 的 APK_PATH）。
func (s *Service) PickFile() (string, error) {
	dialog := (&application.OpenFileDialogStruct{}).
		SetTitle("选择文件").
		CanChooseFiles(true).
		CanChooseDirectories(false)
	return dialog.PromptForSingleSelection()
}
