// Package foreground 是 adb 前台信息域：foreground-info operation 一次输出
// 前台 Activity、焦点窗口（多 display 分组）与 View 树（uiautomator 无障碍树）
// 的格式化报告。解析/排版均为纯函数，采集与编排见 collect.go / register.go。
package foreground

import (
	"regexp"
	"strings"
)

// ForegroundActivity 是 dumpsys activity activities 解析出的前台 Activity。
type ForegroundActivity struct {
	Component string // 完整组件串，如 com.tinnove.launcher/.WallpaperActivity
	Package   string
	ShortName string
	TaskID    string // 归属 task，如 "271"
}

// topResumedRe 匹配 Android 10+ 的 topResumedActivity 行（实测 Android 14 车机）：
// `    topResumedActivity=ActivityRecord{868ec37 u0 com.tinnove.launcher/.WallpaperActivity t271}`
// 兼容多用户 u\d+；旧字段 ResumedActivity: 与之并存，只认 topResumedActivity。
var topResumedRe = regexp.MustCompile(`topResumedActivity=ActivityRecord\{[^ ]+ u\d+ (\S+) t(\d+)\}`)

// parseTopActivity 从 dumpsys activity activities 全文解析前台 Activity，多命中取首个。
func parseTopActivity(dump string) (ForegroundActivity, bool) {
	m := topResumedRe.FindStringSubmatch(dump)
	if m == nil {
		return ForegroundActivity{}, false
	}
	pkg, short := splitComponent(m[1])
	return ForegroundActivity{Component: m[1], Package: pkg, ShortName: short, TaskID: m[2]}, true
}

// splitComponent 拆组件串：`pkg/.Short` 取 '/' 两侧（short 去前导 '.'，保留内部 '.'）；
// 无 '/' 的全名（com.foo.BarActivity）取最后一个 '.' 两侧。
func splitComponent(comp string) (pkg, short string) {
	if i := strings.LastIndex(comp, "/"); i >= 0 {
		return comp[:i], strings.TrimPrefix(comp[i+1:], ".")
	}
	if i := strings.LastIndex(comp, "."); i >= 0 {
		return comp[:i], comp[i+1:]
	}
	return comp, comp
}
