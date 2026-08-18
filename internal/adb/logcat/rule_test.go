package logcat

import (
	"reflect"
	"testing"
)

// entry 快捷构造（等级/tag/message/pid/tid）。
func mkEntry(level, tag, msg string, pid, tid int) Entry {
	return Entry{Level: level, Tag: tag, Message: msg, Pid: pid, Tid: tid}
}

// allow 快捷：编译规则并断言 entries 通过情况。
func allow(t *testing.T, r Rule, e Entry) bool {
	t.Helper()
	cr, err := CompileRule(r)
	if err != nil {
		t.Fatalf("CompileRule(%+v) unexpected error: %v", r, err)
	}
	return cr.Allow(&e)
}

func TestCompileRuleSameKeyOrAcrossKeyAnd(t *testing.T) {
	e := mkEntry("D", "DVR_InitService", "session begin", 4321, 4322)
	r := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "dvr_init"}, // 小写 contains 命中
		{Key: "tag", Op: "contains", Value: "AudioRouter"},
		{Key: "message", Op: "contains", Value: "session"},
	}}
	if !allow(t, r, e) {
		t.Fatal("tag 命中任一 + message 命中 → 应通过")
	}
	// 跨 key AND：tag 命中但 message 不命中 → 排除
	r2 := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "DVR_"},
		{Key: "message", Op: "contains", Value: "FATAL"},
	}}
	if allow(t, r2, e) {
		t.Fatal("message 组无命中 → 应排除")
	}
	// 同 key 内 OR 全不命中 → 排除
	r3 := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "AudioRouter"},
		{Key: "tag", Op: "contains", Value: "SystemUI"},
	}}
	if allow(t, r3, e) {
		t.Fatal("tag 组两个都未命中 → 应排除")
	}
}

func TestCompileRuleNegation(t *testing.T) {
	e := mkEntry("I", "chatty", "GarbageCollector: reclaim", 1207, 1208)
	// 仅取反：命中即排除，未命中通过（其余全放行）
	rNeg := Rule{Tokens: []Token{{Key: "tag", Op: "contains", Negated: true, Value: "chatty"}}}
	if allow(t, rNeg, e) {
		t.Fatal("取反 tag:chatty 命中 → 应排除")
	}
	eOther := mkEntry("I", "AudioRouter", "focus", 8801, 8802)
	if !allow(t, rNeg, eOther) {
		t.Fatal("取反未命中 → 应通过")
	}
	// 多个取反 = 全部规避
	rBoth := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Negated: true, Value: "zzz"},
		{Key: "message", Op: "contains", Negated: true, Value: "garbage"},
	}}
	if allow(t, rBoth, e) {
		t.Fatal("第二个取反命中 → 应排除")
	}
	// 取反 + 正向并存
	rMix := Rule{Tokens: []Token{
		{Key: "pid", Value: "1207"},
		{Key: "message", Op: "contains", Negated: true, Value: "garbage"},
	}}
	if allow(t, rMix, e) {
		t.Fatal("pid 命中但 message 取反命中 → 应排除")
	}
}

func TestCompileRuleOpsAndCase(t *testing.T) {
	e := mkEntry("W", "DVR_TinnoveIpc", "ipc send: focus_request", 4321, 4330)
	// contains 不区分大小写
	if !allow(t, Rule{Tokens: []Token{{Key: "tag", Op: "contains", Value: "dvr_TINNOVEipc"}}}, e) {
		t.Fatal("contains 应不区分大小写")
	}
	// exact 区分大小写
	if allow(t, Rule{Tokens: []Token{{Key: "tag", Op: "exact", Value: "dvr_tinnoveipc"}}}, e) {
		t.Fatal("exact 应区分大小写（小写不应命中）")
	}
	if !allow(t, Rule{Tokens: []Token{{Key: "tag", Op: "exact", Value: "DVR_TinnoveIpc"}}}, e) {
		t.Fatal("exact 全等应命中")
	}
	// regex 区分大小写；(?i) 用户自带
	if !allow(t, Rule{Tokens: []Token{{Key: "message", Op: "regex", Value: "^ipc send: focus_"}}}, e) {
		t.Fatal("regex 前缀应命中")
	}
	if allow(t, Rule{Tokens: []Token{{Key: "message", Op: "regex", Value: "^IPC"}}}, e) {
		t.Fatal("regex 应区分大小写（大写不应命中）")
	}
	if !allow(t, Rule{Tokens: []Token{{Key: "message", Op: "regex", Value: "(?i)^ipc"}}}, e) {
		t.Fatal("regex (?i) 应由用户自带并生效")
	}
	// msg 别名
	if !allow(t, Rule{Tokens: []Token{{Key: "msg", Op: "contains", Value: "focus"}}}, e) {
		t.Fatal("msg 别名应等价 message")
	}
}

func TestCompileRuleAnyBareWord(t *testing.T) {
	e := mkEntry("D", "AudioRouter", "focus_request from codriver", 8801, 8802)
	// 裸词 any：tag 或 message 任一包含即通过
	if !allow(t, Rule{Tokens: []Token{{Key: "any", Op: "contains", Value: "audiorouter"}}}, e) {
		t.Fatal("any 命中 tag → 应通过")
	}
	if !allow(t, Rule{Tokens: []Token{{Key: "any", Op: "contains", Value: "codriver"}}}, e) {
		t.Fatal("any 命中 message → 应通过")
	}
	if allow(t, Rule{Tokens: []Token{{Key: "any", Op: "contains", Value: "chatty"}}}, e) {
		t.Fatal("any 两边都不含 → 应排除")
	}
	// 空 key 容错为 any
	if !allow(t, Rule{Tokens: []Token{{Key: "", Op: "contains", Value: "focus"}}}, e) {
		t.Fatal("空 key 应按 any 处理")
	}
}

func TestCompileRulePidTidExact(t *testing.T) {
	e := mkEntry("D", "DVR_InitService", "x", 4321, 4330)
	if !allow(t, Rule{Tokens: []Token{{Key: "pid", Value: "4321"}}}, e) {
		t.Fatal("pid 精确命中 → 应通过")
	}
	if allow(t, Rule{Tokens: []Token{{Key: "pid", Value: "432"}}}, e) {
		t.Fatal("pid 应为精确匹配（子串不应命中）")
	}
	if !allow(t, Rule{Tokens: []Token{{Key: "tid", Value: "4330"}}}, e) {
		t.Fatal("tid 精确命中 → 应通过")
	}
	// op 一律归一 exact：给 contains 也按精确
	if allow(t, Rule{Tokens: []Token{{Key: "pid", Op: "contains", Value: "32"}}}, e) {
		t.Fatal("pid contains 应被归一为 exact（子串不应命中）")
	}
}

func TestCompileRuleMinLevel(t *testing.T) {
	e := mkEntry("I", "T", "m", 1, 1)
	if !allow(t, Rule{MinLevel: "I"}, e) {
		t.Fatal("I >= I 应通过")
	}
	// 单词形式经 normalizeLevel：warn=W；I(2) < W(3) 应排除
	if allow(t, Rule{MinLevel: "warn"}, e) {
		t.Fatal("I < warn(W) 应排除")
	}
	if allow(t, Rule{MinLevel: "W"}, e) {
		t.Fatal("I < W 应排除")
	}
	ef := mkEntry("F", "T", "m", 1, 1)
	if !allow(t, Rule{MinLevel: "E"}, ef) {
		t.Fatal("F >= E 应通过")
	}
	// 空 MinLevel = V（不过滤）
	if !allow(t, Rule{}, mkEntry("V", "T", "m", 1, 1)) {
		t.Fatal("空规则应全通过")
	}
}

func TestCompileRuleInvalid(t *testing.T) {
	cases := []Rule{
		{Tokens: []Token{{Key: "app", Value: "x"}}},                              // 未知 key
		{Tokens: []Token{{Key: "tag", Op: "fuzzy", Value: "x"}}},                 // 未知 op
		{Tokens: []Token{{Key: "message", Op: "regex", Value: "("}}},             // 非法正则
		{Tokens: []Token{{Key: "pid", Value: "abc"}}},                            // pid 非整数
		{MinLevel: "X"},                                                          // 非法等级
	}
	for i, r := range cases {
		if _, err := CompileRule(r); err == nil {
			t.Errorf("case[%d] %+v 应返回 error", i, r)
		}
	}
	// 空值 token 跳过、不报错
	cr, err := CompileRule(Rule{Tokens: []Token{{Key: "tag", Value: "  "}}})
	if err != nil || cr == nil {
		t.Fatalf("空值 token 应跳过而非报错: %v", err)
	}
}

func TestAllowNilRule(t *testing.T) {
	var cr *CompiledRule
	if !cr.Allow(&Entry{}) {
		t.Fatal("nil 规则应全通过（防御语义）")
	}
}

func TestRuleFromParams(t *testing.T) {
	r := RuleFromParams("warn", "DVR_A DVR_B", "query", "garbage", "com.baidu.che.codriver")
	want := Rule{
		MinLevel: "W",
		Package:  "com.baidu.che.codriver",
		Tokens: []Token{
			{Key: "tag", Op: "contains", Value: "DVR_A"},
			{Key: "tag", Op: "contains", Value: "DVR_B"},
			{Key: "message", Op: "contains", Value: "query"},
			{Key: "message", Op: "contains", Negated: true, Value: "garbage"},
		},
	}
	if !reflect.DeepEqual(r, want) {
		t.Fatalf("映射不符:\n got %+v\nwant %+v", r, want)
	}
	// 全空 = 等价全量
	r2 := RuleFromParams("", "", "", "", "")
	if len(r2.Tokens) != 0 || r2.MinLevel != "" || r2.Package != "" {
		t.Fatalf("全空参数应映射为空规则: %+v", r2)
	}
	// 非法 LEVEL 宽松归零（V），不报错
	r3 := RuleFromParams("X", "", "", "", "")
	if r3.MinLevel != "" {
		t.Fatalf("非法 LEVEL 应宽松处理: %+v", r3)
	}
}

func TestRuleFromParamsExt(t *testing.T) {
	// FILTER JSON 优先：legacy 键全被忽略（哪怕冲突），chip 语言（regex/取反/pid）完整保留
	filter := `{"tokens":[{"key":"tag","op":"regex","value":"^DVR_"},{"key":"pid","op":"exact","value":"4321"},{"key":"message","op":"contains","negated":true,"value":"chatty"}],"minLevel":"I","package":"com.example"}`
	r := RuleFromParamsExt("V", "Foo", "", "", "ignored-pkg", filter)
	want := Rule{
		MinLevel: "I",
		Package:  "com.example",
		Tokens: []Token{
			{Key: "tag", Op: "regex", Value: "^DVR_"},
			{Key: "pid", Op: "exact", Value: "4321"},
			{Key: "message", Op: "contains", Negated: true, Value: "chatty"},
		},
	}
	if !reflect.DeepEqual(r, want) {
		t.Fatalf("FILTER 优先映射不符:\n got %+v\nwant %+v", r, want)
	}

	// FILTER 非法 JSON（手改 yaml 写坏）→ 退化 legacy 映射
	r2 := RuleFromParamsExt("W", "Foo", "inc", "exc", "pkg", "{broken json")
	want2 := RuleFromParams("W", "Foo", "inc", "exc", "pkg")
	if !reflect.DeepEqual(r2, want2) {
		t.Fatalf("非法 FILTER 应退化 legacy:\n got %+v\nwant %+v", r2, want2)
	}

	// FILTER 空 → 同 legacy 直通
	r3 := RuleFromParamsExt("E", "", "", "", "", "  ")
	if r3.MinLevel != "E" {
		t.Fatalf("空 FILTER 应走 legacy: %+v", r3)
	}
}
