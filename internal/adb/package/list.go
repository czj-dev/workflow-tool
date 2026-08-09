package packagemgr

import (
	"fmt"
	"strings"
	"sync"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// handleList 对应 list-packages。
// FILTER=user|system|all（默认 all）。ADBKit 会并发查询 enabled/disabled 再合并，
// 这里保留该行为；all 还会额外合并 user+system 两个范围。
// 每个包通过 EmitStdout 推送一行，返回汇总行。
func handleList(op *adb.OpContext) adb.OpResult {
	scope, err := normalizeFilter(op.ParamStr("FILTER"))
	if err != nil {
		return adb.OpResult{ExitCode: 2, Err: err, Stderr: err.Error()}
	}

	var packages []pkgInfo
	if scope == filterAll {
		userPackages, err := listPackagesForScope(op, filterUser)
		if err != nil {
			return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
		}
		systemPackages, err := listPackagesForScope(op, filterSystem)
		if err != nil {
			return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
		}

		merged := make(map[string]pkgInfo, len(userPackages)+len(systemPackages))
		for _, pkg := range userPackages {
			merged[pkg.PackageName] = pkg
		}
		for _, pkg := range systemPackages {
			merged[pkg.PackageName] = pkg
		}
		packages = sortPackages(mapValues(merged))
	} else {
		result, err := listPackagesForScope(op, scope)
		if err != nil {
			return adb.OpResult{ExitCode: -1, Err: err, Stderr: err.Error()}
		}
		packages = sortPackages(result)
	}

	for _, pkg := range packages {
		op.EmitStdout(fmt.Sprintf("%s\tenabled=%v\tsystem=%v", pkg.PackageName, pkg.IsEnabled, pkg.IsSystemApp))
	}

	summary := fmt.Sprintf("Listed %d package(s) (filter=%s)", len(packages), scope)
	op.EmitStdout(summary)
	return adb.OpResult{ExitCode: 0, Stdout: summary}
}

// listPackagesForScope 并发查询 enabled(-e) 与 disabled(-d) 两类包并按包名合并去重。
func listPackagesForScope(op *adb.OpContext, scope pkgFilter) ([]pkgInfo, error) {
	filterFlag := packageFilterFlag(scope)

	type queryResult struct {
		packages []pkgInfo
		err      error
	}

	results := make(chan queryResult, 2)
	var wg sync.WaitGroup

	for _, enabled := range []bool{true, false} {
		wg.Add(1)
		go func(isEnabled bool) {
			defer wg.Done()
			packages, err := queryPackages(op, filterFlag, scope == filterSystem, isEnabled)
			results <- queryResult{packages: packages, err: err}
		}(enabled)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	merged := make(map[string]pkgInfo)
	for result := range results {
		if result.err != nil {
			return nil, result.err
		}
		for _, pkg := range result.packages {
			merged[pkg.PackageName] = pkg
		}
	}

	return mapValues(merged), nil
}

// queryPackages 执行 `pm list packages -e|-d [范围标志]` 并解析结果。
func queryPackages(op *adb.OpContext, filterFlag string, isSystemApp bool, isEnabled bool) ([]pkgInfo, error) {
	statusFlag := "-d"
	statusName := "disabled"
	if isEnabled {
		statusFlag = "-e"
		statusName = "enabled"
	}

	args := []string{"shell", "pm", "list", "packages", statusFlag}
	if filterFlag != "" {
		args = append(args, filterFlag)
	}

	res, err := adbcore.RunCommand(op.Ctx, op.Adb(args...))
	if res == nil {
		return nil, adbcore.NewOperationError("list-packages",
			fmt.Sprintf("Failed to list %s packages", statusName), err.Error(), true)
	}
	if res.ExitCode != 0 {
		return nil, adbcore.NewOperationError("list-packages",
			fmt.Sprintf("Failed to list %s packages", statusName), strings.TrimSpace(res.Stderr), true)
	}

	return parsePackageListOutput(res.Stdout, isEnabled, isSystemApp), nil
}

func normalizeFilter(filterType string) (pkgFilter, error) {
	switch pkgFilter(strings.ToLower(strings.TrimSpace(filterType))) {
	case filterUser:
		return filterUser, nil
	case filterSystem:
		return filterSystem, nil
	case "", filterAll:
		return filterAll, nil
	default:
		return "", adbcore.NewOperationError("list-packages", "Package filter is invalid",
			fmt.Sprintf("unsupported filter: %s", filterType), false)
	}
}

func packageFilterFlag(filterType pkgFilter) string {
	switch filterType {
	case filterUser:
		return "-3"
	case filterSystem:
		return "-s"
	default:
		return ""
	}
}

func parsePackageListOutput(output string, isEnabled bool, isSystemApp bool) []pkgInfo {
	packages := make([]pkgInfo, 0)
	seen := make(map[string]struct{})

	for _, rawLine := range strings.Split(output, "\n") {
		line := strings.TrimSpace(rawLine)
		if !strings.HasPrefix(line, "package:") {
			continue
		}

		name := strings.TrimSpace(strings.TrimPrefix(line, "package:"))
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}

		seen[name] = struct{}{}
		packages = append(packages, pkgInfo{
			PackageName: name,
			IsEnabled:   isEnabled,
			IsSystemApp: isSystemApp,
		})
	}

	return packages
}
