//go:build darwin

package binary

import (
	"os"
	"path/filepath"

	"workflow-tool/internal/adbcore"
)

func (s *Service) commonPaths(name string) []string {
	home, _ := os.UserHomeDir()
	executable := adbcore.BinaryExecutableName(name)
	return []string{
		filepath.Join(home, "Library", "Android", "sdk", "platform-tools", executable),
		filepath.Join("/usr", "local", "bin", executable),
		filepath.Join("/opt", "homebrew", "bin", executable),
	}
}
