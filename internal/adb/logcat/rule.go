package logcat

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

// 统一过滤规则（spec: docs/superpowers/specs/2026-08-18-logcat-filter-chips-design.md）。
// Token/Rule 与前端 TS 类型对齐，经 Wails 绑定在运行期整体下发；CompileRule 是唯一
// 求值入口，前后端共享同一套语义，前端不再自带过滤逻辑。
//
// 语义（与 frontend/src/mockup/mockLogcat.ts 定稿一致）：
//   - MinLevel 阈值：等级低于阈值即排除（同旧 LEVEL 参数）；
//   - 取反 token：任一命中即排除（多个取反 = 全部规避；link 对取反无意义、忽略）；
//   - 正向 token：按 Link="or" 切成条件组（combo），组间任一组完全命中即通过；
//     组内同 key OR、跨 key AND；无 link = 并入当前组；无正向 token = 通过；
//     （无任何 or-link 的规则退化为单组 = 旧语义，向后兼容）；
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

// token link 常量：正向 token 与前文的组间关系。空/and = 并入当前组（默认，
// 追加行为与旧版一致）；or = 另起条件组（组间任一命中即通过）。仅正向 token
// 生效，取反 token 全局排除与分组无关。
const (
	LinkAnd = "and"
	LinkOr  = "or"
)

// Token 是一条过滤原子。TS 端 LogcatToken 与此逐字段对齐（json tag 即协议）。
type Token struct {
	Key     string `json:"key"`     // tag | message | pid | tid | any
	Op      string `json:"op"`      // contains | exact | regex
	Negated bool   `json:"negated"` // 取反（独立排除语义）
	Value   string `json:"value"`
	Link    string `json:"link,omitempty"` // ""/and=并入当前组；or=另起条件组（仅正向生效）
}

// Rule 是一次完整过滤规则。TS 端 LogcatRule 对齐。MinLevel 为下拉唯一入口；
// Package 运行期可切换（后端换 pid 集，流不重启）。
type Rule struct {
	Tokens   []Token `json:"tokens"`
	MinLevel string  `json:"minLevel"` // V/D/I/W/E/F；空 = V
	Package  string  `json:"package"`  // 包名；空 = 全量进程
}

// cToken 是编译后的 token：别名/算子已归一，正则已编译，contains 预备小写值。
// idx 是该 token 在 Rule.Tokens 中的原下标（Marks 契约：前端按同一序位取色；
// 空值 token 编译时跳过但下标仍按原数组计数，不因跳过而前移）。
type cToken struct {
	key   string
	op    string
	neg   bool
	value string
	lower string         // contains 用（不区分大小写）
	re    *regexp.Regexp // op=regex 时非 nil
	num   int            // key=pid/tid 时非 0
	idx   int            // Rule.Tokens 原下标（Marks 用）
}

// combo 是一个条件组：桶内同 key（OR），桶间跨 key（AND）。
type combo struct {
	buckets  [][]cToken
	bucketAt map[string]int // key → buckets 下标
}

// CompiledRule 是编译后的规则：正/负 token 分离，正向 token 按 Link="or" 切成
// 条件组（组间 OR：任一组全桶命中即通过），组顺序按 token 首次出现顺序（确定性）。
// pos 是正向 token 平铺列表（Marks 枚举用）：不参与 Allow 的短路求值，
// 供「对通过行标出全部命中条件」独立遍历。
type CompiledRule struct {
	minRank int
	minSet  bool
	neg     []cToken
	combos  []combo
	pos     []cToken
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

	for i, t := range r.Tokens {
		if strings.TrimSpace(t.Value) == "" {
			continue // 空值 token 视为未输入，跳过
		}
		key, err := normalizeTokenKey(t.Key)
		if err != nil {
			return nil, fmt.Errorf("token[%d]: %w", i, err)
		}
		ct := cToken{key: key, neg: t.Negated, value: t.Value, idx: i}
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
			// link 对取反无意义：忽略不校验（手写 yaml 容错），语义为全局排除。
			cr.neg = append(cr.neg, ct)
			continue
		}
		cr.pos = append(cr.pos, ct) // Marks 枚举源（与 combos 平行，见 CompiledRule 注释）
		switch t.Link {
		case "", LinkAnd, LinkOr: // 首个正向 token 的 link（含 or）无前组可切，等同并入
		default:
			return nil, fmt.Errorf("token[%d]: unknown link %q (expect and/or)", i, t.Link)
		}
		if t.Link == LinkOr && len(cr.combos) > 0 {
			cr.combos = append(cr.combos, combo{bucketAt: map[string]int{key: 0}, buckets: [][]cToken{{ct}}})
			continue
		}
		if len(cr.combos) == 0 {
			cr.combos = append(cr.combos, combo{bucketAt: map[string]int{key: 0}, buckets: [][]cToken{{ct}}})
			continue
		}
		last := &cr.combos[len(cr.combos)-1]
		if gi, ok := last.bucketAt[key]; ok {
			last.buckets[gi] = append(last.buckets[gi], ct)
		} else {
			last.bucketAt[key] = len(last.buckets)
			last.buckets = append(last.buckets, []cToken{ct})
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
	for _, c := range cr.combos {
		ok := true
		for _, b := range c.buckets {
			hit := false
			for i := range b {
				if b[i].hit(e) {
					hit = true
					break
				}
			}
			if !hit {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return len(cr.combos) == 0
}

// ——— Marks：命中高亮区间（spec: docs/superpowers/specs/2026-09-15-logcat-marks-highlight.md）———
//
// marks 域码（四元组的 f）：面板按列渲染，tag/message 为子串、pid 为整格。
const (
	fieldMessage = 0
	fieldTag     = 1
	fieldPid     = 2
)

// Marks 枚举一条通过行上各正向 token 的全部命中区间（前端命中高亮数据源）。
// 返回四元组 [t, f, s, l]（与前端 events.ts LogcatEntry.marks 镜像，json tag 即协议）：
//   - t = token 在 Rule.Tokens 中的原下标（前端按同一序位取色，草稿 token 同样计数）；
//   - f = 域码 0=message 1=tag 2=pid；tid 面板无列，不产出（过滤语义不受影响）；
//   - s/l = 命中子串在该域字符串内的起点与长度，单位 UTF-16 code unit
//     （对齐 JS string 索引；Go 字节偏移在中文内容下会错位，换算必须经 u16Index）。
// 语义与 Allow 对齐但相互独立：无论哪个条件组促成了放行，所有正向 token 都枚举
// （高亮回答「哪些条件命中了此行」，非「哪条路径放行了此行」）；取反 token 命中
// 的行不会出现在通过集，永不产出。输出按 (t, f, s) 升序——前端重叠区间按序后者
// 覆盖，排序即覆盖优先级。nil 规则 / 无正向 token 无产出。
func (cr *CompiledRule) Marks(e *Entry) [][]int {
	if cr == nil || len(cr.pos) == 0 {
		return nil
	}
	var out [][]int
	for i := range cr.pos {
		t := &cr.pos[i]
		switch t.key {
		case keyPid:
			// pid 域值 = 十进制字符串（ASCII），整域命中：位数即 UTF-16 长度
			if e.Pid == t.num && e.Pid > 0 {
				out = append(out, mark4(t.idx, fieldPid, 0, len(strconv.Itoa(e.Pid))))
			}
		case keyTag:
			out = append(out, t.marks(t.idx, fieldTag, e.Tag)...)
		case keyMessage:
			out = append(out, t.marks(t.idx, fieldMessage, e.Message)...)
		case keyTid:
			// 面板无 tid 列：无落点不产出
		default: // any：tag 与 message 各自命中都标（与 hit 的 any 语义对齐）
			out = append(out, t.marks(t.idx, fieldTag, e.Tag)...)
			out = append(out, t.marks(t.idx, fieldMessage, e.Message)...)
		}
	}
	if len(out) < 2 {
		return out
	}
	sort.Slice(out, func(a, b int) bool {
		for k := 0; k < 3; k++ {
			if out[a][k] != out[b][k] {
				return out[a][k] < out[b][k]
			}
		}
		return false
	})
	return out
}

func mark4(t, f, s, l int) []int { return []int{t, f, s, l} }

// marks 枚举单域内 token 的全部命中区间（UTF-16 单位）。空串域无产出。
func (t *cToken) marks(idx, field int, s string) [][]int {
	if s == "" {
		return nil
	}
	switch t.op {
	case opExact:
		if s == t.value {
			return [][]int{mark4(idx, field, 0, utf16Len(s))}
		}
		return nil
	case opRegex:
		return regexMarks(t.re, idx, field, s)
	default: // contains：不区分大小写，全部出现处（与 Allow 的 matchText 同语义）
		return containsMarks(idx, field, s, t.lower)
	}
}

// u16Index 预计算字符串的 rune 序与两套偏移：byteOff（regex 的字节偏移换算）
// 与 u16Off（UTF-16 code unit 偏移）。len 均为 runes+1，末项即总长。
// 所有 marks 的偏移换算都经它出，保证 s/l 与 JS string 索引严格一致。
type u16Index struct {
	runes   []rune
	byteOff []int
	u16Off  []int
}

func newU16Index(s string) *u16Index {
	ix := &u16Index{}
	u16 := 0
	for i, r := range s {
		ix.runes = append(ix.runes, r)
		ix.byteOff = append(ix.byteOff, i)
		ix.u16Off = append(ix.u16Off, u16)
		u16 += utf16.RuneLen(r) // 1 或 2（>0xFFFF 的增补平面字符）
	}
	ix.byteOff = append(ix.byteOff, len(s))
	ix.u16Off = append(ix.u16Off, u16)
	return ix
}

// byteToU16 字节偏移 → UTF-16 偏移。RE2 命中边界恒在 rune 边界，二分精确命中。
func (ix *u16Index) byteToU16(b int) int {
	return ix.u16Off[sort.SearchInts(ix.byteOff, b)]
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// regexMarks RE2 全部命中。FindAllStringIndex 返回字节偏移，经 u16Index 换算。
func regexMarks(re *regexp.Regexp, idx, field int, s string) [][]int {
	locs := re.FindAllStringIndex(s, -1)
	if len(locs) == 0 {
		return nil
	}
	ix := newU16Index(s)
	out := make([][]int, 0, len(locs))
	for _, lc := range locs {
		from, to := ix.byteToU16(lc[0]), ix.byteToU16(lc[1])
		out = append(out, mark4(idx, field, from, to-from))
	}
	return out
}

// containsMarks 大小写不敏感子串的全部出现处（从左到右、非重叠）。
// strings.ToLower 逐 rune 映射（1:1），折叠文本与原文共享 rune 下标——命中区间
// 直接以 rune 区间映射回原文，再换算 UTF-16，绕开「折叠改变字节长度」的错位坑。
func containsMarks(idx, field int, s, lowerValue string) [][]int {
	if lowerValue == "" {
		return nil
	}
	ix := newU16Index(s)
	folded := make([]rune, len(ix.runes))
	for i, r := range ix.runes {
		folded[i] = unicode.ToLower(r)
	}
	needle := []rune(lowerValue)
	var out [][]int
	for i := 0; i+len(needle) <= len(folded); i++ {
		ok := true
		for j, nr := range needle {
			if folded[i+j] != nr {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, mark4(idx, field, ix.u16Off[i], ix.u16Off[i+len(needle)]-ix.u16Off[i]))
			i += len(needle) - 1 // 跳过整个命中（非重叠）
		}
	}
	return out
}

// ParamFilter 是 preset 携带完整规则的保留参数键（甲板「存为预设」写入）：
// 值为 Rule JSON。legacy 键（LEVEL/TAG/INCLUDE/EXCLUDE/PACKAGE）表达不了 chip 语言
// （正则/精确/pid/取反），FILTER 是权威载体，legacy 键仅供表单展示与手写 yaml 兼容。
const ParamFilter = "FILTER"

// RuleFromParamsExt 在 RuleFromParams 之上优先解析 FILTER 参数：JSON 可解析即整体
// 采用（与前端 ruleFromParams 同构）；不可解析（手改 yaml 写坏）退化 legacy 映射。
// 注意：JSON 合法但规则非法（未知 key/非法正则）不在此处拦，由 CompileRule 硬失败
// （spec 错误处理：不静默降级）。
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
// 参数宽松（不合法的 LEVEL 归 V），因为 RunAction 侧已有必填校验，这里只做兜底。
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
