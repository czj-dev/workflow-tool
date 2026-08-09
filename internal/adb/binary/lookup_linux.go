//go:build linux

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
		filepath.Join(home, "Android", "Sdk", "platform-tools", executable),
		filepath.Join("/usr", "bin", executable),
		filepath.Join("/usr", "local", "bin", executable),
	}
}
