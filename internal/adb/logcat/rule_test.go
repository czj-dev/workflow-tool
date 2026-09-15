package logcat

import (
	"bytes"
	"encoding/json"
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
		{Tokens: []Token{{Key: "app", Value: "x"}}},                  // 未知 key
		{Tokens: []Token{{Key: "tag", Op: "fuzzy", Value: "x"}}},     // 未知 op
		{Tokens: []Token{{Key: "message", Op: "regex", Value: "("}}}, // 非法正则
		{Tokens: []Token{{Key: "pid", Value: "abc"}}},                // pid 非整数
		{MinLevel: "X"}, // 非法等级
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

func TestCompileRuleLinkCombos(t *testing.T) {
	// (tag:A ∧ msg:x) ∨ (tag:B ∧ msg:y)：组间任一全命中即通过
	r := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "A"},
		{Key: "message", Op: "contains", Value: "x"},
		{Key: "tag", Op: "contains", Value: "B", Link: "or"},
		{Key: "message", Op: "contains", Value: "y"},
	}}
	if !allow(t, r, mkEntry("I", "A", "x", 1, 1)) {
		t.Fatal("第一组全命中 → 应通过")
	}
	if !allow(t, r, mkEntry("I", "B", "y", 1, 1)) {
		t.Fatal("第二组全命中 → 应通过")
	}
	if allow(t, r, mkEntry("I", "A", "y", 1, 1)) {
		t.Fatal("跨组各半命中 → 应排除（组内跨 key AND）")
	}
	if allow(t, r, mkEntry("I", "A", "z", 1, 1)) {
		t.Fatal("两组均不全命中 → 应排除")
	}

	// 无 link = 单组 = 旧语义（向后兼容）：A∨B 任一 + msg:x 同时满足
	rSame := Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "A"},
		{Key: "tag", Op: "contains", Value: "B"},
		{Key: "message", Op: "contains", Value: "x"},
	}}
	if !allow(t, rSame, mkEntry("I", "B", "x", 1, 1)) {
		t.Fatal("同 key 任一 + message 命中 → 应通过（旧语义）")
	}

	// 首 token link=or 无前组可切，等同并入；and 显式写同默认
	if !allow(t, Rule{Tokens: []Token{{Key: "tag", Op: "contains", Value: "A", Link: "or"}}},
		mkEntry("I", "A", "m", 1, 1)) {
		t.Fatal("首个 token link=or 应被忽略（无前组）")
	}
	if !allow(t, Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "A"},
		{Key: "message", Op: "contains", Value: "m", Link: "and"},
	}}, mkEntry("I", "A", "m", 1, 1)) {
		t.Fatal("link=and 显式写同默认（同组 AND）")
	}

	// 取反 token 携 link：忽略不校验，仍全局排除
	if allow(t, Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "A"},
		{Key: "message", Op: "contains", Value: "x"},
		{Key: "tag", Op: "contains", Negated: true, Value: "A", Link: "or"},
	}}, mkEntry("I", "A", "x", 1, 1)) {
		t.Fatal("取反命中应全局排除，link 不改变语义")
	}

	// 未知 link 硬失败（手改 yaml 尽早暴露）
	if _, err := CompileRule(Rule{Tokens: []Token{
		{Key: "tag", Op: "contains", Value: "A"},
		{Key: "message", Op: "contains", Value: "m", Link: "xor"},
	}}); err == nil {
		t.Fatal("未知 link 应返回 error")
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

// ——— Marks：命中高亮区间（四元组 [t,f,s,l]，UTF-16 单位）———

func marksOf(t *testing.T, r Rule, e Entry) [][]int {
	t.Helper()
	return mustCompile(t, r).Marks(&e)
}

func TestMarksContainsAllOccurrences(t *testing.T) {
	e := mkEntry("I", "T", "a >==>> b >==>> c", 1, 1)
	got := marksOf(t, Rule{Tokens: []Token{{Key: "message", Op: "contains", Value: ">==>>"}}}, e)
	want := [][]int{{0, 0, 2, 5}, {0, 0, 10, 5}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("全部出现处（非重叠）不符:\n got %v\nwant %v", got, want)
	}
	// 重叠出现不交叠：aaaa 包含 aa → 两段 (0,2)(2,4)
	got2 := marksOf(t, Rule{Tokens: []Token{{Key: "message", Op: "contains", Value: "aa"}}}, mkEntry("I", "T", "aaaa", 1, 1))
	if !reflect.DeepEqual(got2, [][]int{{0, 0, 0, 2}, {0, 0, 2, 2}}) {
		t.Fatalf("非重叠扫描不符: %v", got2)
	}
}

func TestMarksUTF16Offsets(t *testing.T) {
	// 中文+emoji：字节偏移会错位，必须按 UTF-16 code unit
	// "中文🙂abc"：中(1)文(1)🙂(2) → abc 起点 4；命中 ABC（contains 不区分大小写）
	e := mkEntry("I", "T", "中文🙂abc", 1, 1)
	got := marksOf(t, Rule{Tokens: []Token{{Key: "message", Op: "contains", Value: "ABC"}}}, e)
	if !reflect.DeepEqual(got, [][]int{{0, 0, 4, 3}}) {
		t.Fatalf("UTF-16 偏移不符: %v", got)
	}
	// emoji 在正则命中区间内：长度也要按 UTF-16（🙂 = 2）
	got2 := marksOf(t, Rule{Tokens: []Token{{Key: "message", Op: "regex", Value: "文."}}}, e)
	if !reflect.DeepEqual(got2, [][]int{{0, 0, 1, 3}}) {
		t.Fatalf("正则跨 emoji 的 UTF-16 长度不符: %v", got2)
	}
}

func TestMarksFieldsAndOps(t *testing.T) {
	// tag 域（f=1）contains 子串区间
	got := marksOf(t, Rule{Tokens: []Token{{Key: "tag", Op: "contains", Value: "init"}}},
		mkEntry("I", "DVR_InitService", "x", 1, 1))
	if !reflect.DeepEqual(got, [][]int{{0, 1, 4, 4}}) {
		t.Fatalf("tag 域区间不符: %v", got)
	}
	// exact 整域
	got = marksOf(t, Rule{Tokens: []Token{{Key: "tag", Op: "exact", Value: "DVR_InitService"}}},
		mkEntry("I", "DVR_InitService", "x", 1, 1))
if !reflect.DeepEqual(got, [][]int{{0, 1, 0, 15}}) {
		t.Fatalf("exact 整域不符: %v", got)
	}
	// pid 域（f=2）十进制整域；tid 无列不产出
	e := mkEntry("I", "T", "x", 4321, 4330)
	got = marksOf(t, Rule{Tokens: []Token{{Key: "pid", Value: "4321"}}}, e)
	if !reflect.DeepEqual(got, [][]int{{0, 2, 0, 4}}) {
		t.Fatalf("pid 整域不符: %v", got)
	}
	got = marksOf(t, Rule{Tokens: []Token{{Key: "tid", Value: "4330"}}}, e)
	if got != nil {
		t.Fatalf("tid 无列不应产出: %v", got)
	}
	// regex 全部命中
	got = marksOf(t, Rule{Tokens: []Token{{Key: "message", Op: "regex", Value: "\\d+"}}},
		mkEntry("I", "T", "ipc 12 ms 345 end", 1, 1))
	if !reflect.DeepEqual(got, [][]int{{0, 0, 4, 2}, {0, 0, 10, 3}}) {
		t.Fatalf("regex 全部命中不符: %v", got)
	}
}

func TestMarksAnyDualFieldAndSort(t *testing.T) {
	// any 裸词：tag 与 message 各自命中都发（同 t 不同 f）
	e := mkEntry("I", "AudioRouter", "focus from AudioRouter", 1, 1)
	got := marksOf(t, Rule{Tokens: []Token{{Key: "any", Op: "contains", Value: "audiorouter"}}}, e)
	want := [][]int{{0, 0, 11, 11}, {0, 1, 0, 11}} // (t,f,s) 升序：message(0) 前 tag(1)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("any 双域/排序不符:\n got %v\nwant %v", got, want)
	}
	// 多 token：按 t 升序，且空值 token 跳过后原下标保持
	r := Rule{Tokens: []Token{
		{Key: "message", Op: "contains", Value: "  "}, // 空值跳过，占位下标 0
		{Key: "message", Op: "contains", Value: "focus"}, // t=1
		{Key: "tag", Op: "exact", Value: "AudioRouter"},  // t=2
	}}
	got = marksOf(t, r, e)
	want = [][]int{{1, 0, 0, 5}, {2, 1, 0, 11}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("原下标保持/排序不符:\n got %v\nwant %v", got, want)
	}
}

func TestMarksNegatedAndNil(t *testing.T) {
	// 取反 token 永不产出；正向 token 照常枚举（即使非放行路径的组）
	e := mkEntry("I", "Alpha", "hello world", 1, 1)
	got := marksOf(t, Rule{Tokens: []Token{
		{Key: "tag", Op: "exact", Value: "Alpha"},
		{Key: "message", Op: "contains", Negated: true, Value: "zzz"},
	}}, e)
	if !reflect.DeepEqual(got, [][]int{{0, 1, 0, 5}}) {
		t.Fatalf("取反不应产出: %v", got)
	}
	// ∨ 分组下未促成放行的组也枚举（高亮回答「哪些条件命中」，非「哪条路径放行」）
	got = marksOf(t, Rule{Tokens: []Token{
		{Key: "tag", Op: "exact", Value: "Alpha"},
		{Key: "tag", Op: "exact", Value: "Nope", Link: "or"},
		{Key: "message", Op: "contains", Value: "world", Link: "or"},
	}}, e)
	want := [][]int{{0, 1, 0, 5}, {2, 0, 6, 5}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("非放行组也应枚举:\n got %v\nwant %v", got, want)
	}
	// nil 规则 / 无正向 token 无产出
	var nilCR *CompiledRule
	if nilCR.Marks(&e) != nil {
		t.Fatal("nil 规则应无产出")
	}
	if got := marksOf(t, Rule{MinLevel: "I"}, e); got != nil {
		t.Fatalf("无正向 token 应无产出: %v", got)
	}
}

func TestEntryJSONMarksOmitEmpty(t *testing.T) {
	e := mkEntry("I", "T", "x", 1, 1)
	// 无 marks → 字段缺省（omitempty 契约）
	b, err := json.Marshal(entryJSON(e, nil))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte("marks")) {
		t.Fatalf("无 marks 不应携带字段: %s", b)
	}
	// 有 marks → 字段存在
	b2, err := json.Marshal(entryJSON(e, [][]int{{0, 0, 0, 1}}))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b2, []byte(`"marks":[[0,0,0,1]]`)) {
		t.Fatalf("marks 应按四元组序列化: %s", b2)
	}
}

func TestRuleFromParamsExt(t *testing.T) {
	// FILTER JSON 优先：legacy 键全被忽略（哪怕冲突），chip 语言（regex/取反/pid/link）完整保留
	filter := `{"tokens":[{"key":"tag","op":"regex","value":"^DVR_"},{"key":"pid","op":"exact","value":"4321"},{"key":"message","op":"contains","negated":true,"value":"chatty"},{"key":"tag","op":"contains","value":"Audio","link":"or"}],"minLevel":"I","package":"com.example"}`
	r := RuleFromParamsExt("V", "Foo", "", "", "ignored-pkg", filter)
	want := Rule{
		MinLevel: "I",
		Package:  "com.example",
		Tokens: []Token{
			{Key: "tag", Op: "regex", Value: "^DVR_"},
			{Key: "pid", Op: "exact", Value: "4321"},
			{Key: "message", Op: "contains", Negated: true, Value: "chatty"},
			{Key: "tag", Op: "contains", Value: "Audio", Link: "or"},
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
