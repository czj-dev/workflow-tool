package file

import (
	"fmt"
	"path"

	"workflow-tool/internal/adb"
	"workflow-tool/internal/adbcore"
)

// listFilesTree 组装 list-files 树帧根节点：root=目录本身，children=条目。
// kind=dir/file（符号链接目标已剥离、归 file）；file 的 detail=`大小 · 日期`，
// dir 保持安静；path=设备完整路径（叶子点击复制用）。
func listFilesTree(normalized string, entries []Entry) adb.TreeNode {
	root := adb.TreeNode{Label: normalized, Kind: "dir", Path: normalized}
	for _, e := range entries {
		n := adb.TreeNode{Label: e.Name, Path: e.Path}
		if e.Type == dirType {
			n.Kind = "dir"
		} else {
			n.Kind = "file"
			n.Detail = e.SizeHuman + " · " + e.ModifiedAt
		}
		root.Children = append(root.Children, n)
	}
	return root
}

// handleListFiles lists the contents of a remote directory.
// Params: REMOTE_PATH (default /sdcard/), SHOW_HIDDEN (bool).
// 输出形态是一帧树（stream "tree"，前端渲染内联树块，替代原逐行文本列表）。
func handleListFiles(op *adb.OpContext) adb.OpResult {
	const opName = "list-files"
	normalized, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	showHidden := op.ParamBool("SHOW_HIDDEN")

	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "ls", "-lAL", quoteShellArg(normalized)))
	if runErr != nil {
		return runFail(op, opName, "Failed to list files", res, runErr, true)
	}
	entries, parseErr := parseFileListOutput(res.Stdout, normalized, showHidden)
	if parseErr != nil {
		return paramErr(op, opName, "Failed to parse file listing", parseErr.Error())
	}

	op.EmitTree(adb.TreeFrame{
		Title: fmt.Sprintf("%s · %d 项", normalized, len(entries)),
		Nodes: []adb.TreeNode{listFilesTree(normalized, entries)},
	})
	summary := fmt.Sprintf("%d item(s) in %s", len(entries), normalized)
	return adb.OpResult{ExitCode: 0, Stdout: summary}
}

// handleMkdir creates a remote directory (and parents).
// Params: REMOTE_PATH (required).
func handleMkdir(op *adb.OpContext) adb.OpResult {
	const opName = "mkdir"
	normalized, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	if err := validateRemoteMutationPath(opName, normalized); err != nil {
		return abortWith(op, opName, err)
	}

	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "mkdir", "-p", quoteShellArg(normalized)))
	if runErr != nil {
		return runFail(op, opName, "Failed to create directory", res, runErr, true)
	}
	msg := fmt.Sprintf("Created directory %s", path.Base(normalized))
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: msg}
}

// handleDelete removes a remote file or directory (rm -rf).
// Params:
//   - REMOTE_PATH (required)
//   - ALLOW_PROTECTED (optional, default false): 允许删除 /data、/sdcard 之外的
//     受保护系统分区（/system、/vendor 等）。设备根 "/" 永远拒绝。
func handleDelete(op *adb.OpContext) adb.OpResult {
	const opName = "delete"
	normalized, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}
	// 根路径无论如何都挡；rm -rf / 是灾难，没有可救的场景。
	if normalized == "/" || normalized == "." {
		return abortWith(op, opName, adbcore.NewOperationError(opName, "Remote path is too broad", "refusing to delete device root path", false))
	}
	if !op.ParamBool("ALLOW_PROTECTED") {
		if err := validateRemoteMutationPath(opName, normalized); err != nil {
			return abortWith(op, opName, err)
		}
	}

	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "rm", "-rf", quoteShellArg(normalized)))
	if runErr != nil {
		return runFail(op, opName, "Failed to delete path", res, runErr, true)
	}
	msg := fmt.Sprintf("Deleted %s", path.Base(normalized))
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: msg}
}

// handleRename moves/renames a remote path.
// Params: REMOTE_PATH (required), NEW_REMOTE_PATH (required).
func handleRename(op *adb.OpContext) adb.OpResult {
	const opName = "rename"
	oldRaw := op.ParamStr("REMOTE_PATH")
	if oldRaw == "" {
		return paramErr(op, opName, "REMOTE_PATH is required", "remote path is empty")
	}
	newRaw := op.ParamStr("NEW_REMOTE_PATH")
	if newRaw == "" {
		return paramErr(op, opName, "NEW_REMOTE_PATH is required", "new remote path is empty")
	}
	oldPath, err := normalizeRemotePath(oldRaw)
	if err != nil {
		return abortWith(op, opName, err)
	}
	newPath, err := normalizeRemotePath(newRaw)
	if err != nil {
		return abortWith(op, opName, err)
	}
	if err := validateRemoteMutationPath(opName, oldPath); err != nil {
		return abortWith(op, opName, err)
	}
	if err := validateRemoteMutationPath(opName, newPath); err != nil {
		return abortWith(op, opName, err)
	}

	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "mv", quoteShellArg(oldPath), quoteShellArg(newPath)))
	if runErr != nil {
		return runFail(op, opName, "Failed to rename path", res, runErr, true)
	}
	msg := fmt.Sprintf("Renamed %s -> %s", path.Base(oldPath), path.Base(newPath))
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: msg}
}

// handleDirectorySize reports the on-device size of a remote directory (du -sh).
// Params: REMOTE_PATH (required).
func handleDirectorySize(op *adb.OpContext) adb.OpResult {
	const opName = "directory-size"
	normalized, err := normalizeRemotePath(op.ParamStr("REMOTE_PATH"))
	if err != nil {
		return abortWith(op, opName, err)
	}

	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "du", "-sh", quoteShellArg(normalized)))
	if runErr != nil {
		return runFail(op, opName, "Failed to calculate directory size", res, runErr, true)
	}
	size := parseDirectorySizeOutput(res.Stdout)
	msg := fmt.Sprintf("%s: %s", normalized, size)
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: msg}
}

// handleStorageInfo reports df-style storage usage for /sdcard.
// Params: none.
func handleStorageInfo(op *adb.OpContext) adb.OpResult {
	const opName = "storage-info"
	res, runErr := adbcore.RunCommand(op.Ctx, op.Adb("shell", "df", "-k", "/sdcard"))
	if runErr != nil {
		return runFail(op, opName, "Failed to get storage info", res, runErr, true)
	}
	info, parseErr := parseStorageInfoOutput(res.Stdout)
	if parseErr != nil {
		return paramErr(op, opName, "Failed to parse storage info", parseErr.Error())
	}
	msg := formatStorage(info)
	op.EmitStdout(msg)
	return adb.OpResult{ExitCode: 0, Stdout: msg}
}
