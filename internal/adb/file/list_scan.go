package file

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

const defaultListDepth = 4
const defaultListTimeout = 5 * time.Second

var errInvalidListOutput = errors.New("invalid directory listing")
var errListProcess = errors.New("failed to run adb")

type listDirectory struct {
	path  string
	depth int
}

// handleListFiles scans at most DEPTH levels under one deadline, keeping entries
// from completed and interrupted directories when the deadline expires.
func handleListFiles(op *adb.OpContext) adb.OpResult {
	const opName = "list-files"
	rootPath, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	depth := defaultListDepth
	if raw := op.ParamStr("DEPTH"); raw != "" {
		depth, err = strconv.Atoi(raw)
		if err != nil || depth < 1 {
			return paramErr(op, opName, "Invalid DEPTH", "DEPTH must be a positive integer")
		}
	}
	timeout := op.Timeout
	if timeout <= 0 {
		timeout = defaultListTimeout
	}
	ctx, cancel := context.WithTimeout(op.Ctx, timeout)
	defer cancel()

	queue := []listDirectory{{path: rootPath}}
	entriesByPath := make(map[string][]Entry)
	failures := make(map[string]string)
	incomplete := make(map[string]bool)
	var warnings []string
	count := 0
	timedOut := false
	for len(queue) > 0 {
		if op.Ctx.Err() != nil {
			return cancelledResult(opName)
		}
		if ctx.Err() != nil {
			timedOut = true
			break
		}
		current := queue[0]
		queue = queue[1:]
		entries, detail, runErr := listDirectoryEntries(ctx, op, current.path, op.ParamBool("SHOW_HIDDEN"))
		if op.Ctx.Err() != nil {
			return cancelledResult(opName)
		}
		if runErr == nil || len(entries) > 0 {
			entriesByPath[current.path] = entries
			count += len(entries)
		}
		if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			if current.path == rootPath && len(entries) == 0 {
				return paramErr(op, opName, "Failed to list files", "根目录超时，尚未取得任何结果")
			}
			incomplete[current.path] = true
			timedOut = true
			break
		}
		if runErr != nil {
			if current.path == rootPath || errors.Is(runErr, errInvalidListOutput) || errors.Is(runErr, errListProcess) || !isInaccessibleDirectory(detail) {
				return paramErr(op, opName, "Failed to list files", fmt.Sprintf("%s: %s", current.path, detail))
			}
			failures[current.path] = detail
			warnings = append(warnings, fmt.Sprintf("%s: %s", current.path, detail))
			continue
		}
		if current.depth+1 >= depth {
			continue
		}
		for _, entry := range entries {
			if entry.Type == dirType {
				queue = append(queue, listDirectory{path: entry.Path, depth: current.depth + 1})
			}
		}
	}
	if timedOut {
		warnings = append(warnings, fmt.Sprintf("扫描超时（%s），仅展示已取得的结果", timeout))
	}
	for _, warning := range warnings {
		op.EmitStderr(warning)
	}
	title := fmt.Sprintf("%s · %d 项", rootPath, count)
	if timedOut || len(failures) > 0 {
		title += " · 部分结果"
	}
	root := buildFileTree(rootPath, entriesByPath, failures, incomplete, depth, timedOut)
	if op.Ctx.Err() != nil {
		return cancelledResult(opName)
	}
	op.EmitTree(adb.TreeFrame{
		Title: title, Nodes: []adb.TreeNode{root}, DefaultExpandAll: true,
	})
	return adb.OpResult{ExitCode: 0, Stdout: fmt.Sprintf("%d item(s) in %s", count, rootPath), Stderr: strings.Join(warnings, "\n")}
}

func listDirectoryEntries(ctx context.Context, op *adb.OpContext, dir string, showHidden bool) ([]Entry, string, error) {
	var entries []Entry
	var parseErr error
	var stderr strings.Builder
	pathArg := strings.TrimSuffix(dir, "/") + "/"
	req := op.AdbStream(false, func(stream, line string) {
		if stream == "stderr" {
			stderr.WriteString(line)
			stderr.WriteByte('\n')
			return
		}
		if parseErr != nil || strings.TrimSpace(line) == "" || strings.HasPrefix(line, "total ") {
			return
		}
		entry, ok, err := parseFileListLine(strings.TrimLeft(line, " \t"), dir)
		if err != nil {
			parseErr = err
		} else if ok && (showHidden || !entry.IsHidden) {
			entries = append(entries, entry)
		}
	}, "shell", "ls", "-lA", quoteShellArg(pathArg))
	res, err := adbcore.RunStreaming(ctx, req)
	if parseErr != nil && !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return entries, parseErr.Error(), fmt.Errorf("%w: %w", errInvalidListOutput, parseErr)
	}
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		if res == nil && ctx.Err() == nil {
			return entries, detail, fmt.Errorf("%w: %w", errListProcess, err)
		}
		return entries, detail, err
	}
	return entries, "", nil
}

func isInaccessibleDirectory(detail string) bool {
	lower := strings.ToLower(detail)
	return strings.Contains(lower, "permission denied") || strings.Contains(lower, "access denied") ||
		strings.Contains(lower, "no such file") || strings.Contains(lower, "not a directory")
}

func listFilesTree(normalized string, entries []Entry) adb.TreeNode {
	return buildFileTree(normalized, map[string][]Entry{normalized: entries}, nil, nil, 1, false)
}

func buildFileTree(rootPath string, entriesByPath map[string][]Entry, failures map[string]string, incomplete map[string]bool, depth int, timedOut bool) adb.TreeNode {
	root := adb.TreeNode{Label: rootPath, Kind: "dir", Path: rootPath}
	for _, entry := range entriesByPath[rootPath] {
		properties := map[string]any{
			"type": entry.Type, "permissions": entry.Permissions, "modifiedAt": entry.ModifiedAt,
		}
		node := adb.TreeNode{Label: entry.Name, Path: entry.Path, Kind: entry.Type, Properties: properties}
		if entry.Type == dirType {
			node.Kind = "dir"
			node.Children = buildFileTree(entry.Path, entriesByPath, failures, incomplete, depth-1, timedOut).Children
			if detail, ok := failures[entry.Path]; ok {
				properties["error"] = detail
				node.Detail = detail
			} else if incomplete[entry.Path] {
				properties["status"] = "未扫描完（超时）"
				node.Detail = "未扫描完（超时）"
			} else if _, scanned := entriesByPath[entry.Path]; timedOut && depth > 1 && !scanned {
				properties["status"] = "未扫描（超时）"
				node.Detail = "未扫描（超时）"
			}
		} else {
			properties["size"] = entry.SizeHuman
			node.Detail = entry.SizeHuman + " · " + entry.ModifiedAt
			if entry.Type == symlinkType && entry.LinkTarget != "" {
				properties["target"] = entry.LinkTarget
			}
		}
		root.Children = append(root.Children, node)
	}
	if incomplete[rootPath] {
		root.Detail = "未扫描完（超时）"
	}
	return root
}
