package logcat

import (
	"regexp"
	"strings"
)

// threadtimeRe 解析 `logcat -v threadtime` 输出，移植自 ADBKit logcat_service.go。
// 例: "08-08 11:22:33.456  1234  5678 W ActivityManager: something happened"
// 捕获组: 1=date 2=time 3=pid 4=tid 5=level 6=tag 7=message
var threadtimeRe = regexp.MustCompile(`^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?):\s?(.*)$`)

// Entry 是一条解析后的 logcat 行，对齐 adbkit-logcat 的 Entry 模型
// (date/pid/tid/priority/tag/message)。Date/Time/Level 为结构化字段供前端着色与
// 运行时过滤；未解析的原始行 Date/Time/Pid/Tid 留零、Level='V'、Message=原文。
type Entry struct {
	Date    string // "08-08"；未解析行为 ""
	Time    string // "11:22:33.456"；未解析行为 ""
	Pid     int    // 进程 ID；未解析行为 0
	Tid     int    // 线程 ID；未解析行为 0
	Level   string // V/D/I/W/E/F；未解析行默认 "V"
	Tag     string // 未解析行为 ""
	Message string // 未解析行为整行原文
	Raw     string // 原始行（去掉行尾换行），供 batch 落盘用
}

// parseEntry 解析单行 threadtime 输出。无法匹配的行保留原文为 message、level=V。
func parseEntry(raw string) Entry {
	line := strings.TrimRight(raw, "\r\n")
	e := Entry{Level: "V", Message: line, Raw: line}
	m := threadtimeRe.FindStringSubmatch(line)
	if len(m) != 8 {
		return e
	}
	e.Date = m[1]
	e.Time = m[2]
	e.Pid = atoi(m[3])
	e.Tid = atoi(m[4])
	e.Level = m[5]
	e.Tag = strings.TrimSpace(m[6])
	e.Message = m[7]
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

// allow 判断一条解析后的 Entry 是否通过全部过滤规则。
func (f *filter) allow(e *Entry) bool {
	if f.levelSet && levelRank(e.Level) < f.minLevel {
		return false
	}
	if len(f.tags) > 0 {
		tag := strings.ToLower(e.Tag)
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
	if f.include != "" && !strings.Contains(strings.ToLower(e.Message), f.include) {
		return false
	}
	if f.exclude != "" && strings.Contains(strings.ToLower(e.Message), f.exclude) {
		return false
	}
	return true
}

// atoi 解析十进制 int；失败返回 0（logcat 的 pid/tid 为正整数，无需复杂错误处理）。
func atoi(s string) int {
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}
