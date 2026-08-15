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

// focusKV 是一行焦点键值对。
type focusKV struct {
	Key   string
	Value string
}

// WindowDisplay 是单个 display 的焦点窗口摘要。
type WindowDisplay struct {
	ID    string // display id，如 "8"；无块头 fallback 块为 ""
	Focus []focusKV
}

// 块头两种形态：真机 Android 14 车机 `Display: mDisplayId=8 (organized)`；
// 部分 ROM 为 `Display 8`。都认，避免对 OEM 格式押注单一形态。
var windowDisplayHeaderRes = []*regexp.Regexp{
	regexp.MustCompile(`^\s*Display: mDisplayId=(\d+)`),
	regexp.MustCompile(`^\s*Display (\d+)`),
}

// windowFocusKeys 是要提取的焦点键（按 dumpsys 输出顺序自然出现）。
var windowFocusKeys = []string{"mCurrentFocus", "mFocusedApp", "mInputMethodTarget", "mTopFullscreenOpaqueWindowState"}

// parseWindowDisplays 解析 dumpsys window displays：按块头分组，块内提取焦点键值行。
// 无块头而直接出现焦点行时归入单个隐式块（ID ""）。
func parseWindowDisplays(dump string) []WindowDisplay {
	var out []WindowDisplay
	cur := -1
	for _, raw := range strings.Split(dump, "\n") {
		matched := false
		for _, re := range windowDisplayHeaderRes {
			if m := re.FindStringSubmatch(raw); m != nil {
				out = append(out, WindowDisplay{ID: m[1]})
				cur = len(out) - 1
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		line := strings.TrimSpace(raw)
		for _, key := range windowFocusKeys {
			v, ok := strings.CutPrefix(line, key+"=")
			if !ok {
				continue
			}
			if cur < 0 { // 无块头 fallback：隐式单块
				out = append(out, WindowDisplay{})
				cur = 0
			}
			out[cur].Focus = append(out[cur].Focus, focusKV{Key: key, Value: strings.TrimSpace(v)})
			break
		}
	}
	return out
}
