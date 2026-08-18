package logcat

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 统一过滤规则（spec: docs/superpowers/specs/2026-08-18-logcat-filter-chips-design.md）。
// Token/Rule 与前端 TS 类型对齐，经 Wails 绑定在运行期整体下发；CompileRule 是唯一
// 求值入口，前后端共享同一套语义，前端不再自带过滤逻辑。
//
// 语义（与 frontend/src/mockup/mockLogcat.ts 定稿一致）：
//   - MinLevel 阈值：等级低于阈值即排除（同旧 LEVEL 参数）；
//   - 取反 token：任一命中即排除（多个取反 = 全部规避）；
//   - 正向 token：同 key 内 OR，跨 key AND；无正向 token = 通过；
//   - 大小写：contains 不区分；exact / regex 区分（需要不区分时用户自带 (?i)）；
//   - pid / tid 仅精确整数匹配。

// token key 常量（Normalized 后的规范 key；msg 为 message 的输入别名，编译时归一）。
const (
	keyTag     = "tag"
	keyMessage = "message"
	keyPid     = "pid"
	keyTid     = "tid"
	keyAny     = "any"
)

// token op 常量。
const (
	opContains = "contains"
	opExact    = "exact"
	opRegex    = "regex"
)

// Token 是一条过滤原子。TS 端 LogcatToken 与此逐字段对齐（json tag 即协议）。
type Token struct {
	Key     string `json:"key"`     // tag | message | pid | tid | any
	Op      string `json:"op"`      // contains | exact | regex
	Negated bool   `json:"negated"` // 取反（独立排除语义）
	Value   string `json:"value"`
}

// Rule 是一次完整过滤规则。TS 端 LogcatRule 对齐。MinLevel 为下拉唯一入口；
// Package 运行期可切换（后端换 pid 集，流不重启）。
type Rule struct {
	Tokens   []Token `json:"tokens"`
	MinLevel string  `json:"minLevel"` // V/D/I/W/E/F；空 = V
	Package  string  `json:"package"`  // 包名；空 = 全量进程
}

// cToken 是编译后的 token：别名/算子已归一，正则已编译，contains 预备小写值。
type cToken struct {
	key   string
	op    string
	neg   bool
	value string
	lower string         // contains 用（不区分大小写）
	re    *regexp.Regexp // op=regex 时非 nil
	num   int            // key=pid/tid 时非 0
}

// CompiledRule 是编译后的规则：正/负 token 分离，正向 token 按 key 分组
// （组内 OR，组间 AND），组顺序按 token 首次出现顺序（确定性）。
type CompiledRule struct {
	minRank int
	minSet  bool
	neg     []cToken
	groups  [][]cToken // 每组同 key
}

// normalizeTokenKey 归一 key 别名（msg→message），未知 key 报错（TS/Go 漂移尽早暴露）。
func normalizeTokenKey(k string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(k)) {
	case "tag":
		return keyTag, nil
	case "message", "msg":
		return keyMessage, nil
	case "pid":
		return keyPid, nil
	case "tid":
		return keyTid, nil
	case "any", "": // 裸词语义在前端已归为 any；空 key 容错为 any
		return keyAny, nil
	default:
		return "", fmt.Errorf("unknown filter key %q (expect tag/message/pid/tid/any)", k)
	}
}

// CompileRule 校验并编译规则。任何非法输入（未知 key、未知 op、非法正则、
// pid/tid 非整数、非法 MinLevel）返回 error——调用方应沿用旧规则继续运行，
// 不做静默降级（spec 错误处理定稿）。
func CompileRule(r Rule) (*CompiledRule, error) {
	cr := &CompiledRule{}
	lvl, ok := normalizeLevel(r.MinLevel)
	if !ok {
		return nil, fmt.Errorf("invalid minLevel %q (expect V/D/I/W/E/F)", r.MinLevel)
	}
	if lvl != "" {
		cr.minSet = true
		cr.minRank = levelRank(lvl)
	}

	groupIdx := map[string]int{} // key → groups 下标
	for i, t := range r.Tokens {
		if strings.TrimSpace(t.Value) == "" {
			continue // 空值 token 视为未输入，跳过
		}
		key, err := normalizeTokenKey(t.Key)
		if err != nil {
			return nil, fmt.Errorf("token[%d]: %w", i, err)
		}
		ct := cToken{key: key, neg: t.Negated, value: t.Value}
		switch key {
		case keyPid, keyTid:
			// 数字维度仅精确匹配，op 一律归一为 exact（与前端解析一致）。
			n, err := strconv.Atoi(strings.TrimSpace(t.Value))
			if err != nil {
				return nil, fmt.Errorf("token[%d]: %s value must be an integer, got %q", i, key, t.Value)
			}
			ct.op = opExact
			ct.num = n
		default:
			switch t.Op {
			case "", opContains:
				ct.op = opContains
				ct.lower = strings.ToLower(t.Value)
			case opExact:
				ct.op = opExact
			case opRegex:
				ct.op = opRegex
				re, err := regexp.Compile(t.Value)
				if err != nil {
					return nil, fmt.Errorf("token[%d]: invalid regex %q: %w", i, t.Value, err)
				}
				ct.re = re
			default:
				return nil, fmt.Errorf("token[%d]: unknown op %q (expect contains/exact/regex)", i, t.Op)
			}
		}
		if ct.neg {
			cr.neg = append(cr.neg, ct)
			continue
		}
		gi, ok := groupIdx[key]
		if !ok {
			cr.groups = append(cr.groups, []cToken{ct})
			groupIdx[key] = len(cr.groups) - 1
		} else {
			cr.groups[gi] = append(cr.groups[gi], ct)
		}
	}
	return cr, nil
}

// hit 判断单条编译后 token 是否命中。any 在 exact/regex 下为 tag 或 message 任一命中。
func (t *cToken) hit(e *Entry) bool {
	switch t.key {
	case keyTag:
		return t.matchText(e.Tag)
	case keyMessage:
		return t.matchText(e.Message)
	case keyPid:
		return e.Pid == t.num
	case keyTid:
		return e.Tid == t.num
	default: // any
		if t.matchText(e.Tag) {
			return true
		}
		return t.matchText(e.Message)
	}
}

// matchText 按 op 匹配单字段：contains 不区分大小写；exact/regex 区分。
func (t *cToken) matchText(s string) bool {
	switch t.op {
	case opExact:
		return s == t.value
	case opRegex:
		return t.re != nil && t.re.MatchString(s)
	default:
		return strings.Contains(strings.ToLower(s), t.lower)
	}
}

// Allow 判断一条解析后的 Entry 是否通过规则（nil 视为无规则全通过）。
func (cr *CompiledRule) Allow(e *Entry) bool {
	if cr == nil {
		return true
	}
	if cr.minSet && levelRank(e.Level) < cr.minRank {
		return false
	}
	for i := range cr.neg {
		if cr.neg[i].hit(e) {
			return false
		}
	}
	for _, g := range cr.groups {
		ok := false
		for i := range g {
			if g[i].hit(e) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// ParamFilter 是 preset 携带完整规则的保留参数键（甲板「存为预设」写入）：
// 值为 Rule JSON。legacy 键（LEVEL/TAG/INCLUDE/EXCLUDE/PACKAGE）表达不了 chip 语言
// （正则/精确/pid/取反），FILTER 是权威载体，legacy 键仅供表单展示与手写 yaml 兼容。
const ParamFilter = "FILTER"

// RuleFromParamsExt 在 RuleFromParams 之上优先解析 FILTER 参数：JSON 可解析即整体
// 采用（与前端 ruleFromParams 同构）；不可解析（手改 yaml 写坏）退化 legacy 映射。
// 注意：JSON 合法但规则非法（未知 key/非法正则）不在此处拦，由 CompileRule 硬失败
//（spec 错误处理：不静默降级）。
func RuleFromParamsExt(levelRaw, tagRaw, includeRaw, excludeRaw, pkg, filterRaw string) Rule {
	if s := strings.TrimSpace(filterRaw); s != "" {
		var r Rule
		if err := json.Unmarshal([]byte(s), &r); err == nil {
			return r
		}
	}
	return RuleFromParams(levelRaw, tagRaw, includeRaw, excludeRaw, pkg)
}

// RuleFromParams 把 adb-logcat-stream 的传统启动参数映射为统一规则（spec 启动映射）。
// TAG 按空白拆分为多个 tag contains token；INCLUDE/EXCLUDE 映射 message 正/负 token。
// 参数宽松（不合法的 LEVEL 归 V），因为 RunAction 侧已有必填校验，这里只做兑底。
func RuleFromParams(levelRaw, tagRaw, includeRaw, excludeRaw, pkg string) Rule {
	r := Rule{Package: pkg}
	lvl, ok := normalizeLevel(levelRaw)
	if ok && lvl != "" {
		r.MinLevel = lvl
	}
	for _, t := range strings.Fields(tagRaw) {
		r.Tokens = append(r.Tokens, Token{Key: keyTag, Op: opContains, Value: t})
	}
	if inc := strings.TrimSpace(includeRaw); inc != "" {
		r.Tokens = append(r.Tokens, Token{Key: keyMessage, Op: opContains, Value: inc})
	}
	if exc := strings.TrimSpace(excludeRaw); exc != "" {
		r.Tokens = append(r.Tokens, Token{Key: keyMessage, Op: opContains, Negated: true, Value: exc})
	}
	return r
}
