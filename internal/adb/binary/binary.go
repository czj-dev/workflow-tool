// Package binary 探测 adb/fastboot/scrcpy 可执行文件路径。
// 级联：config 显式路径 -> exec.LookPath(PATH) -> 平台常见路径。
// 不做托管下载（v1 走 config.yaml + PATH 探测）。
package binary

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"

	"workflow-tool/internal/adbcore"
)

// Service 是无状态的二进制探测器。
type Service struct{}

// NewService 构造探测器。
func NewService() *Service { return &Service{} }

// Paths 是三个二进制的已解析路径。
type Paths struct {
	Adb      string
	Fastboot string
	Scrcpy   string
}

// Paths 解析三个二进制（空覆盖 -> 级联探测）。解析失败回退到裸名交由 exec.LookPath 兜底。
func (s *Service) Paths(adbPath, fastbootPath, scrcpyPath string) Paths {
	adb, _ := s.Resolve(adbcore.BinaryNameAdb, adbPath)
	fastboot, _ := s.Resolve(adbcore.BinaryNameFastboot, fastbootPath)
	scrcpy, _ := s.Resolve(adbcore.BinaryNameScrcpy, scrcpyPath)
	if adb == "" {
		adb = adbcore.BinaryNameAdb
	}
	if fastboot == "" {
		fastboot = adbcore.BinaryNameFastboot
	}
	if scrcpy == "" {
		scrcpy = adbcore.BinaryNameScrcpy
	}
	return Paths{Adb: adb, Fastboot: fastboot, Scrcpy: scrcpy}
}

// Resolve 返回 name 的可执行路径（级联：configuredPath -> PATH -> 常见路径）。
// 仅校验可执行性，不跑版本命令（运行时解析用，快）。找不到返回 "" + error。
func (s *Service) Resolve(name, configuredPath string) (string, error) {
	if !adbcore.IsSupportedBinaryName(name) {
		return "", adbcore.NewOperationError("binary", "unsupported binary name", name, false)
	}
	if configuredPath != "" {
		if adbcore.ValidateBinaryExecutable(name, configuredPath) == nil {
			return configuredPath, nil
		}
	}
	if p, err := exec.LookPath(adbcore.BinaryExecutableName(name)); err == nil {
		if adbcore.ValidateBinaryExecutable(name, p) == nil {
			return p, nil
		}
	}
	for _, candidate := range s.commonPaths(name) {
		if adbcore.ValidateBinaryExecutable(name, candidate) == nil {
			return candidate, nil
		}
	}
	return "", adbcore.NewOperationError("binary", "binary not found", name, true)
}

// Detect 解析 + 计算版本/来源，供 UI 显示状态。
func (s *Service) Detect(name, configuredPath string) adbcore.BinaryInfo {
	info := adbcore.BinaryInfo{Name: name, Status: adbcore.BinaryMissing}
	if !adbcore.IsSupportedBinaryName(name) {
		info.Status = adbcore.BinaryInvalid
		info.Reason = "unsupported binary name"
		return info
	}
	if configuredPath != "" {
		cand := s.resolveCandidate(name, configuredPath, "config", true)
		if cand.Status == adbcore.BinaryReady {
			return cand
		}
		info = cand
	}
	if p, err := exec.LookPath(adbcore.BinaryExecutableName(name)); err == nil {
		cand := s.resolveCandidate(name, p, "system-path", false)
		if cand.Status == adbcore.BinaryReady {
			return cand
		}
	}
	for _, candidate := range s.commonPaths(name) {
		cand := s.resolveCandidate(name, candidate, "common-path", false)
		if cand.Status == adbcore.BinaryReady {
			return cand
		}
	}
	return info
}

func (s *Service) resolveCandidate(name, path, source string, explicit bool) adbcore.BinaryInfo {
	info := adbcore.BinaryInfo{Name: name, Path: path, Source: source, Status: adbcore.BinaryMissing}
	if err := adbcore.ValidateBinaryExecutable(name, path); err != nil {
		if explicit {
			info.Status = adbcore.BinaryInvalid
			info.Reason = err.Error()
		}
		return info
	}
	version, err := getVersion(name, path)
	if err != nil {
		info.Status = adbcore.BinaryInvalid
		info.Reason = err.Error()
		return info
	}
	info.Status = adbcore.BinaryReady
	info.Version = version
	return info
}

func getVersion(name, path string) (string, error) {
	var lastErr error
	for _, args := range versionCommands(name) {
		result, err := adbcore.RunCommand(context.Background(), adbcore.ExecRequest{
			Command: path,
			Args:    args,
			Timeout: 5 * time.Second,
		})
		if err != nil {
			lastErr = err
			continue
		}
		if result.ExitCode != 0 {
			lastErr = errors.New(strings.TrimSpace(result.Stderr))
			continue
		}
		version := parseVersion(result.Stdout)
		if version == "" {
			version = parseVersion(result.Stderr)
		}
		if version != "" {
			return version, nil
		}
		lastErr = errors.New("version output is empty")
	}
	if lastErr != nil {
		return "", lastErr
	}
	return "", errors.New("version command is unavailable")
}

func versionCommands(name string) [][]string {
	switch name {
	case adbcore.BinaryNameAdb:
		return [][]string{{"version"}}
	case adbcore.BinaryNameFastboot:
		return [][]string{{"--version"}, {"version"}}
	case adbcore.BinaryNameScrcpy:
		return [][]string{{"--version"}}
	default:
		return [][]string{{"--version"}}
	}
}

func parseVersion(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}
