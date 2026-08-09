package adbcore

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// 支持的二进制名。
const (
	BinaryNameAdb      = "adb"
	BinaryNameFastboot = "fastboot"
	BinaryNameScrcpy   = "scrcpy"
)

// IsSupportedBinaryName 判断 name 是否为受支持的二进制。
func IsSupportedBinaryName(name string) bool {
	switch name {
	case BinaryNameAdb, BinaryNameFastboot, BinaryNameScrcpy:
		return true
	default:
		return false
	}
}

// BinaryExecutableName 返回平台相关的可执行文件名（Windows 加 .exe）。
func BinaryExecutableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// ValidatePath 校验路径存在且可访问，拒绝 .. 目录穿越。
func ValidatePath(path string) error {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return NewOperationError("validation", "path is empty", "", false)
	}
	if strings.Contains(trimmed, ".."+string(filepath.Separator)) || trimmed == ".." {
		return NewOperationError("validation", "path traversal is not allowed", trimmed, false)
	}
	info, err := os.Stat(trimmed)
	if err != nil {
		if os.IsNotExist(err) {
			return NewOperationError("validation", "path does not exist", trimmed, false)
		}
		return NewOperationError("validation", "cannot access path", err.Error(), true)
	}
	_ = info
	return nil
}

// ValidateExecutable 校验路径指向一个可执行文件。
func ValidateExecutable(path string) error {
	if err := ValidatePath(path); err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return NewOperationError("validation", "cannot stat file", err.Error(), true)
	}
	if info.IsDir() {
		return NewOperationError("validation", "path is a directory, not a file", path, false)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return NewOperationError("validation", "file is not executable", path, false)
	}
	return nil
}

// ValidateBinaryExecutable 校验路径是名称匹配的合法二进制。
func ValidateBinaryExecutable(name, path string) error {
	if !IsSupportedBinaryName(name) {
		return NewOperationError("validation", "unsupported binary name", name, false)
	}
	if err := ValidateExecutable(path); err != nil {
		return err
	}
	actualName := strings.TrimSuffix(strings.ToLower(filepath.Base(path)), ".exe")
	if actualName != name {
		return NewOperationError("validation", "binary name does not match", path, false)
	}
	return nil
}

var allowedAPKExtensions = map[string]struct{}{
	".apk": {},
}

// ValidateAPKFile 校验文件是 .apk 且存在。
func ValidateAPKFile(filePath string) error {
	trimmedPath := strings.TrimSpace(filePath)
	if trimmedPath == "" {
		return NewOperationError("validate_apk_file", "APK file path is required", "file path must not be empty", false)
	}
	extension := strings.ToLower(filepath.Ext(trimmedPath))
	if _, ok := allowedAPKExtensions[extension]; !ok {
		return NewOperationError("validate_apk_file", "APK file type is invalid", "only .apk files are allowed", false)
	}
	info, err := os.Stat(trimmedPath)
	if err != nil {
		return NewOperationError("validate_apk_file", "File could not be accessed", err.Error(), false)
	}
	if info.IsDir() {
		return NewOperationError("validate_apk_file", "File path points to a directory", "expected a regular file", false)
	}
	return nil
}

// EnsureDir 创建目录及所有父目录。
func EnsureDir(path string) error {
	return os.MkdirAll(path, 0o755)
}

// ParentDir 返回路径的父目录。
func ParentDir(path string) string {
	return filepath.Dir(path)
}
