package logcat

import (
	"regexp"
	"strings"
)

// threadtimeRe 解析 `logcat -v threadtime` 输出，移植自 ADBKit logcat_service.go。
// 例: "08-08 11:22:33.456  1234  5678 W ActivityManager: something happened"
// 捕获组: 1=date 2=time 3=pid 4=tid 5=level 6=tag 7=message
var threadtimeRe = regexp.MustCompile(`^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?):\s?(.*)$`)

// entry 是一条 logcat 行解析后的过滤相关字段。
type entry struct {
	level   string // V/D/I/W/E/F；未解析行默认 "V"
	tag     string // 未解析行为 ""
	message string // 未解析行为整行原文
}

// parseEntry 解析单行 threadtime 输出。无法匹配的行保留原文为 message、level=V、tag=""。
func parseEntry(raw string) entry {
	line := strings.TrimRight(raw, "\r\n")
	e := entry{level: "V", message: line}
	m := threadtimeRe.FindStringSubmatch(line)
	if len(m) != 8 {
		return e
	}
	e.level = m[5]
	e.tag = strings.TrimSpace(m[6])
	e.message = m[7]
	return e
}

// levelRank 把 Android 日志等级映射为可比较的严重度序数（越大越严重）。
// 未知等级按 Verbose(0) 处理，故仅在阈值为 V 时通过。
func levelRank(level string) int {
	switch strings.ToUpper(level) {
	case "V":
		return 0
	case "D":
		return 1
	case "I":
		return 2
	case "W":
		return 3
	case "E":
		return 4
	case "F":
		return 5
	default:
		return 0
	}
}

// normalizeLevel 接受单字母 (V/D/I/W/E/F) 或单词形式 (Verbose/Warn/Warning/Error...)，
// 返回大写单字母。空串视为未设置。无法识别返回 ok=false。
func normalizeLevel(s string) (string, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if s == "" {
		return "", true
	}
	c := s[:1]
	if strings.IndexByte("VDIWEF", c[0]) >= 0 {
		return c, true
	}
	return "", false
}

// filter 封装 LEVEL/TAG/INCLUDE/EXCLUDE 规则。所有匹配串在构造时小写化，避免逐行重复计算。
type filter struct {
	levelSet bool     // LEVEL 是否已设置（false=不过滤等级）
	minLevel int      // levelRank(LEVEL)；行等级 >= minLevel 才通过
	tags     []string // TAG 按空白拆分并小写化；任一为 tag 子串即通过；空=不按 tag 过滤
	include  string   // 小写；message 须包含；空=不要求
	exclude  string   // 小写；message 须不包含；空=不排除
}

// buildFilter 由操作入参构造 filter。ok=false 表示 LEVEL 非法。
func buildFilter(levelRaw, tagRaw, includeRaw, excludeRaw string) (filter, bool) {
	f := filter{}
	lvl, ok := normalizeLevel(levelRaw)
	if !ok {
		return f, false
	}
	if lvl != "" {
		f.levelSet = true
		f.minLevel = levelRank(lvl)
	}
	for _, t := range strings.Fields(tagRaw) {
		f.tags = append(f.tags, strings.ToLower(t))
	}
	if inc := strings.TrimSpace(includeRaw); inc != "" {
		f.include = strings.ToLower(inc)
	}
	if exc := strings.TrimSpace(excludeRaw); exc != "" {
		f.exclude = strings.ToLower(exc)
	}
	return f, true
}

// allow 判断一条解析后的 entry 是否通过全部过滤规则。
func (f *filter) allow(e *entry) bool {
	if f.levelSet && levelRank(e.level) < f.minLevel {
		return false
	}
	if len(f.tags) > 0 {
		tag := strings.ToLower(e.tag)
		hit := false
		for _, t := range f.tags {
			if strings.Contains(tag, t) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	if f.include != "" && !strings.Contains(strings.ToLower(e.message), f.include) {
		return false
	}
	if f.exclude != "" && strings.Contains(strings.ToLower(e.message), f.exclude) {
		return false
	}
	return true
}
