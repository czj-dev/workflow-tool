package packagemgr

import (
	"fmt"
	"strings"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleDetails 对应 package-details：解析 dumpsys package 得到版本/数据大小，
// 再用 pm path + stat 取 APK 大小，du 兜底数据大小，最终格式化推送。
func handleDetails(op *adb.OpContext) adb.OpResult {
	pkg, fail := requireSinglePackage(op, "package-details")
	if fail != nil {
		return *fail
	}

	details := pkgDetails{
		PackageName:   pkg,
		ApkSizeBytes:  -1,
		DataSizeBytes: -1,
	}

	// 1. dumpsys package：版本 + 数据大小。
	if infoRes, _ := adbcore.RunCommand(op.Ctx, op.Adb("shell", "dumpsys", "package", pkg)); infoRes != nil {
		details.VersionName, details.VersionCode = parsePackageVersionOutput(infoRes.Stdout)
		details.DataSizeBytes = parseDataSizeFromDumpsys(infoRes.Stdout)
	}

	// 2. pm path + stat：APK 大小。
	if pathRes, _ := adbcore.RunCommand(op.Ctx, op.Adb("shell", "pm", "path", pkg)); pathRes != nil {
		if remotePath, parseErr := parsePackagePathOutput(pathRes.Stdout); parseErr == nil {
			if apkRes, _ := adbcore.RunCommand(op.Ctx, op.Adb("shell", "stat", "-c", "%s", remotePath)); apkRes != nil {
				details.ApkSizeBytes = parseByteSizeOutput(apkRes.Stdout)
			}
		}
	}

	// 3. 数据大小兜底：du -s /data/data/<pkg>，再 /data/user/0/<pkg>。
	if details.DataSizeBytes < 0 {
		if r, _ := adbcore.RunCommand(op.Ctx, op.Adb("shell", "du", "-s", fmt.Sprintf("/data/data/%s", pkg))); r != nil && r.ExitCode == 0 {
			details.DataSizeBytes = parseDUSizeOutput(r.Stdout)
		}
	}
	if details.DataSizeBytes < 0 {
		if r, _ := adbcore.RunCommand(op.Ctx, op.Adb("shell", "du", "-s", fmt.Sprintf("/data/user/0/%s", pkg))); r != nil && r.ExitCode == 0 {
			details.DataSizeBytes = parseDUSizeOutput(r.Stdout)
		}
	}

	// 4. 合计大小。
	if details.ApkSizeBytes >= 0 && details.DataSizeBytes >= 0 {
		details.TotalSizeBytes = details.ApkSizeBytes + details.DataSizeBytes
	} else if details.ApkSizeBytes >= 0 {
		details.TotalSizeBytes = details.ApkSizeBytes
	} else if details.DataSizeBytes >= 0 {
		details.TotalSizeBytes = details.DataSizeBytes
	}

	report := formatDetails(details)
	op.EmitStdout(report)
	return adb.OpResult{ExitCode: 0, Stdout: report}
}

// formatDetails 把结构化明细格式化为多行文本（未知大小显示 unknown）。
func formatDetails(d pkgDetails) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Package: %s\n", d.PackageName)

	version := strings.TrimSpace(d.VersionName)
	code := strings.TrimSpace(d.VersionCode)
	if version == "" && code == "" {
		fmt.Fprintf(&b, "Version: unknown\n")
	} else if code == "" {
		fmt.Fprintf(&b, "Version: %s\n", version)
	} else {
		fmt.Fprintf(&b, "Version: %s (code %s)\n", version, code)
	}

	fmt.Fprintf(&b, "APK Size: %s\n", sizeOrUnknown(d.ApkSizeBytes))
	fmt.Fprintf(&b, "Data Size: %s\n", sizeOrUnknown(d.DataSizeBytes))
	fmt.Fprintf(&b, "Total Size: %s", sizeOrUnknown(d.TotalSizeBytes))
	return b.String()
}

func sizeOrUnknown(bytes int64) string {
	if bytes < 0 {
		return "unknown"
	}
	return fmt.Sprintf("%d bytes", bytes)
}
