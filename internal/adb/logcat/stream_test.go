package logcat

import (
	"reflect"
	"testing"
)

func mustCompile(t *testing.T, r Rule) *CompiledRule {
	t.Helper()
	cr, err := CompileRule(r)
	if err != nil {
		t.Fatalf("CompileRule(%+v) error: %v", r, err)
	}
	return cr
}

// ——— ring ———

func TestRingOrderBeforeFull(t *testing.T) {
	r := newRing(4)
	for i := 0; i < 3; i++ {
		r.push(mkEntry("I", "T", "m", i, i))
	}
	if r.len() != 3 {
		t.Fatalf("len = %d, want 3", r.len())
	}
	snap := r.snapshot()
	if len(snap) != 3 {
		t.Fatalf("snapshot len = %d, want 3", len(snap))
	}
	for i, e := range snap {
		if e.Pid != i {
			t.Fatalf("snapshot[%d].Pid = %d, want %d（应按时间序最旧→最新）", i, e.Pid, i)
		}
	}
}

func TestRingTruncation(t *testing.T) {
	r := newRing(4)
	for i := 0; i < 7; i++ { // 容量 4，写入 7：只留最新 4 条（pid 3..6）
		r.push(mkEntry("I", "T", "m", i, i))
	}
	if r.len() != 4 {
		t.Fatalf("len = %d, want 4", r.len())
	}
	snap := r.snapshot()
	for i, e := range snap {
		if e.Pid != 3+i {
			t.Fatalf("snapshot[%d].Pid = %d, want %d（绕回后应从最旧存活条目起序）", i, e.Pid, 3+i)
		}
	}
}

func TestRingClear(t *testing.T) {
	r := newRing(4)
	r.push(mkEntry("I", "T", "m", 1, 1))
	r.clear()
	if r.len() != 0 || len(r.snapshot()) != 0 {
		t.Fatalf("clear 后 ring 应为空，len=%d snapshot=%d", r.len(), len(r.snapshot()))
	}
	r.push(mkEntry("I", "T", "m", 9, 9))
	if snap := r.snapshot(); len(snap) != 1 || snap[0].Pid != 9 {
		t.Fatalf("clear 后应可继续写入，got %+v", snap)
	}
}

// ——— allowEntry：pid 集语义 ———

func TestAllowEntryPidSemantics(t *testing.T) {
	cr := mustCompile(t, Rule{})
	e := mkEntry("I", "T", "m", 100, 100)
	if !allowEntry(cr, nil, &e) {
		t.Fatal("pids=nil（无包过滤）应全通过")
	}
	if allowEntry(cr, map[int]struct{}{}, &e) {
		t.Fatal("空 pid 集（包未运行）应全排除")
	}
	if !allowEntry(cr, map[int]struct{}{100: {}}, &e) {
		t.Fatal("pid 在集合内应通过")
	}
	if allowEntry(cr, map[int]struct{}{200: {}}, &e) {
		t.Fatal("pid 不在集合内应排除")
	}
}

// ——— buildReplaceFrames ———

func TestBuildReplaceFramesChunking(t *testing.T) {
	const total = replaceChunk*2 + 201 // 1201 条全部命中 → 500/500/201 三帧
	snap := make([]Entry, total)
	for i := range snap {
		snap[i] = mkEntry("I", "T", "m", i, i)
	}
	frames := buildReplaceFrames(snap, mustCompile(t, Rule{}), nil)
	if len(frames) != 3 {
		t.Fatalf("frames = %d, want 3", len(frames))
	}
	if !frames[0].Head || frames[1].Head || frames[2].Head {
		t.Fatalf("仅首帧应 head=true，got %v %v %v", frames[0].Head, frames[1].Head, frames[2].Head)
	}
	if len(frames[0].Entries) != replaceChunk || len(frames[1].Entries) != replaceChunk || len(frames[2].Entries) != 201 {
		t.Fatalf("chunk 大小 = %d/%d/%d, want %d/%d/201",
			len(frames[0].Entries), len(frames[1].Entries), len(frames[2].Entries), replaceChunk, replaceChunk)
	}
	if frames[0].Matched != total || frames[0].Total != total {
		t.Fatalf("head 帧 matched/total = %d/%d, want %d/%d", frames[0].Matched, frames[0].Total, total, total)
	}
	// 非首帧不应携带计数/直方图（omitempty 契约）
	if frames[1].Matched != 0 || frames[1].Total != 0 || frames[1].TagHistogram != nil {
		t.Fatal("非首帧不应携带 matched/total/tagHistogram")
	}
	// 条目顺序与内容按快照序重组
	seen := 0
	for _, f := range frames {
		for _, p := range f.Entries {
			if p.Pid != seen {
				t.Fatalf("重组顺序错位：期望 pid=%d，got %d", seen, p.Pid)
			}
			seen++
		}
	}
	if seen != total {
		t.Fatalf("重组条目数 = %d, want %d", seen, total)
	}
}

func TestBuildReplaceFramesMatchedTotalHistogram(t *testing.T) {
	snap := []Entry{
		mkEntry("I", "Alpha", "hello", 1, 1),
		mkEntry("D", "Alpha", "hello", 1, 1), // 低于 MinLevel=I：排除
		mkEntry("W", "Beta", "world", 2, 2),
		mkEntry("E", "Beta", "noise", 3, 3),  // 取反 token 排除 message=noise
		mkEntry("I", "Gamma", "hello", 4, 4), // pid 不在集合：排除
	}
	cr := mustCompile(t, Rule{
		Tokens:   []Token{{Key: "message", Op: "contains", Negated: true, Value: "noise"}},
		MinLevel: "I",
	})
	frames := buildReplaceFrames(snap, cr, map[int]struct{}{1: {}, 2: {}, 3: {}})
	if len(frames) != 1 || !frames[0].Head {
		t.Fatalf("命中少于一个 chunk 应单首帧，got %d 帧", len(frames))
	}
	f := frames[0]
	if f.Matched != 2 || f.Total != 5 {
		t.Fatalf("matched/total = %d/%d, want 2/5", f.Matched, f.Total)
	}
	want := map[string]int{"Alpha": 1, "Beta": 1} // 直方图只统计命中条目
	if !reflect.DeepEqual(f.TagHistogram, want) {
		t.Fatalf("tagHistogram = %v, want %v", f.TagHistogram, want)
	}
	for _, p := range f.Entries {
		if p.Tag == "Gamma" || p.Message == "noise" || p.Level == "D" {
			t.Fatalf("不该出现的条目: %+v", p)
		}
	}
}

func TestBuildReplaceFramesEmptyMatch(t *testing.T) {
	snap := []Entry{mkEntry("I", "T", "m", 1, 1), mkEntry("I", "T", "m", 2, 2)}
	cr := mustCompile(t, Rule{Tokens: []Token{{Key: "tag", Op: "exact", Value: "Nothing"}}})
	frames := buildReplaceFrames(snap, cr, nil)
	if len(frames) != 1 || !frames[0].Head {
		t.Fatalf("零命中应返回单个首帧，got %+v", frames)
	}
	f := frames[0]
	if f.Matched != 0 || f.Total != 2 || len(f.Entries) != 0 || f.TagHistogram == nil {
		t.Fatalf("零命中首帧 = matched %d / total %d / entries %d / hist %v, want 0/2/0/空map",
			f.Matched, f.Total, len(f.Entries), f.TagHistogram)
	}
}

// ——— topTags ———

func TestTopTagsTruncationAndTie(t *testing.T) {
	hist := map[string]int{"big": 10, "mid": 5, "a": 1, "b": 1}
	if got := topTags(hist, 10); !reflect.DeepEqual(got, hist) {
		t.Fatalf("未超上限应原样返回，got %v", got)
	}
	top := topTags(hist, 2)
	if len(top) != 2 || top["big"] != 10 || top["mid"] != 5 {
		t.Fatalf("top-2 = %v, want {big:10 mid:5}", top)
	}
	// 并列按 tag 字典序：a、b 同为 1，取 3 名时应收 a 而非 b（确定性）
	all := map[string]int{"b": 1, "a": 1, "z": 9}
	if got := topTags(all, 2); !reflect.DeepEqual(got, map[string]int{"z": 9, "a": 1}) {
		t.Fatalf("并列应按 tag 字典序截断，got %v", got)
	}
}
