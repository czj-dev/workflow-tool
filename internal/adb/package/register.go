// Package packagemgr 把 ADBKit 的 package_mgr 域移植为 workflow-tool 的 adb 子包。
// 目录为 internal/adb/package/（package 是 Go 关键字，故包名用 packagemgr）。
// 所有 operation 在 init() 中自登记，供 ADBRunner 按 operation 名分发。
package packagemgr

import "workflow-tool/internal/adb"

func init() {
	adb.RegisterOperation("install-package", handleInstall)
	adb.RegisterOperation("uninstall-package", handleUninstall)
	adb.RegisterOperation("list-packages", handleList)
	adb.RegisterOperation("enable-package", handleEnable)
	adb.RegisterOperation("disable-package", handleDisable)
	adb.RegisterOperation("clear-data", handleClearData)
	adb.RegisterOperation("force-stop", handleForceStop)
	adb.RegisterOperation("pull-apk", handlePull)
	adb.RegisterOperation("package-details", handleDetails)
}
