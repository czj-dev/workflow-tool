//go:build windows

package binary

import (
	"os"
	"path/filepath"

	"workflow-tool/internal/adbcore"
)

func (s *Service) commonPaths(name string) []string {
	home, _ := os.UserHomeDir()
	localAppData := os.Getenv("LOCALAPPDATA")
	androidHome := os.Getenv("ANDROID_HOME")
	androidSDKRoot := os.Getenv("ANDROID_SDK_ROOT")
	executable := adbcore.BinaryExecutableName(name)

	// 基准变量为空时 filepath.Join 会产出相对路径（如 "platform-tools\adb.exe"），
	// 相对 CWD 解析可能意外命中，故拼前先判空。
	var paths []string
	if androidSDKRoot != "" {
		paths = append(paths, filepath.Join(androidSDKRoot, "platform-tools", executable))
	}
	if androidHome != "" {
		paths = append(paths, filepath.Join(androidHome, "platform-tools", executable))
	}
	if localAppData != "" {
		paths = append(paths, filepath.Join(localAppData, "Android", "Sdk", "platform-tools", executable))
	}
	if home != "" {
		paths = append(paths, filepath.Join(home, "AppData", "Local", "Android", "Sdk", "platform-tools", executable))
	}
	paths = append(paths, filepath.Join("C:", "Android", "Sdk", "platform-tools", executable))

	seen := make(map[string]struct{})
	result := make([]string, 0, len(paths))
	for _, candidate := range paths {
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	return result
}
