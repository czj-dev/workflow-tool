package packagemgr

import (
	"fmt"
	"sort"
	"strings"

	"workflow-tool/internal/adbcore"
)

// validatePackageName 校验包名非空并返回去空白后的值。
func validatePackageName(packageName string) (string, error) {
	trimmed := strings.TrimSpace(packageName)
	if trimmed == "" {
		return "", adbcore.NewOperationError("package", "Package name is required", "package name must not be empty", false)
	}
	return trimmed, nil
}

// parsePackagePathOutput 从 `pm path <pkg>` 输出中解析第一条 package: 行。
func parsePackagePathOutput(output string) (string, error) {
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSpace(rawLine)
		if !strings.HasPrefix(line, "package:") {
			continue
		}

		path := strings.TrimSpace(strings.TrimPrefix(line, "package:"))
		if path != "" {
			return path, nil
		}
	}

	return "", fmt.Errorf("package path was not found in command output")
}

// parsePackageVersionOutput 从 dumpsys package 输出解析 versionName / versionCode。
func parsePackageVersionOutput(output string) (string, string) {
	var versionName, versionCode string

	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSpace(rawLine)
		if strings.Contains(line, "versionName=") {
			versionName = strings.TrimSpace(strings.SplitN(line, "versionName=", 2)[1])
		}
		if strings.Contains(line, "versionCode=") {
			value := strings.TrimSpace(strings.SplitN(line, "versionCode=", 2)[1])
			versionCode = strings.Fields(value)[0]
		}
	}

	return versionName, versionCode
}

// parseDataSizeFromDumpsys 从 dumpsys 输出解析 dataSize=/Data Size: 行。
func parseDataSizeFromDumpsys(output string) int64 {
	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSpace(rawLine)
		if strings.Contains(line, "dataSize=") {
			parts := strings.SplitN(line, "dataSize=", 2)
			if len(parts) == 2 {
				var size int64
				_, err := fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &size)
				if err == nil && size > 0 {
					return size
				}
			}
		}
		if strings.Contains(line, "Data Size:") {
			parts := strings.SplitN(line, "Data Size:", 2)
			if len(parts) == 2 {
				var size int64
				_, err := fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &size)
				if err == nil && size > 0 {
					return size
				}
			}
		}
	}
	return -1
}

// parseByteSizeOutput 从 `stat -c %s` 这类纯数字输出解析字节数。
func parseByteSizeOutput(output string) int64 {
	line := strings.TrimSpace(extractFirstLine(output))
	if line == "" {
		return -1
	}

	var size int64
	_, err := fmt.Sscanf(line, "%d", &size)
	if err != nil {
		return -1
	}

	return size
}

// parseDUSizeOutput 从 `du -s` 输出解析（块数 × 1024）。
func parseDUSizeOutput(output string) int64 {
	line := strings.TrimSpace(extractFirstLine(output))
	if line == "" {
		return -1
	}

	var blocks int64
	_, err := fmt.Sscanf(line, "%d", &blocks)
	if err != nil {
		return -1
	}

	return blocks * 1024
}

func extractFirstLine(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func fallbackMessage(output string, fallback string) string {
	line := extractFirstLine(output)
	if line != "" {
		return line
	}
	return fallback
}

func sortPackages(packages []pkgInfo) []pkgInfo {
	sort.Slice(packages, func(i, j int) bool {
		return packages[i].PackageName < packages[j].PackageName
	})
	return packages
}

func mapValues[K comparable, V any](input map[K]V) []V {
	values := make([]V, 0, len(input))
	for _, value := range input {
		values = append(values, value)
	}
	return values
}
