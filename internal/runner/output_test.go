package runner

import "testing"

func TestParseOutputLine(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantKey   string
		wantValue string
		wantOK    bool
	}{
		{"标准协议行", "##[output foo=bar]", "foo", "bar", true},
		{"值含等号", "##[output url=http://a.com?x=1]", "url", "http://a.com?x=1", true},
		{"值为空", "##[output empty=]", "empty", "", true},
		{"普通行不匹配", "hello world", "", "", false},
		{"缺右括号", "##[output foo=bar", "", "", false},
		{"缺 key", "##[output =bar]", "", "", false},
		{"前后有空格", "  ##[output foo=bar]  ", "foo", "bar", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			key, value, ok := parseOutputLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if !ok {
				return
			}
			if key != c.wantKey || value != c.wantValue {
				t.Fatalf("got (%q,%q), want (%q,%q)", key, value, c.wantKey, c.wantValue)
			}
		})
	}
}

func TestParseProgressLine(t *testing.T) {
	cases := []struct {
		name     string
		line     string
		wantText string
		wantOK   bool
	}{
		{"标准协议行", "##[progress 下载 42%]", "下载 42%", true},
		{"文本含方括号", "##[progress a[b] 1/2]", "a[b] 1/2", true},
		{"文本为空", "##[progress ]", "", true},
		{"普通行不匹配", "下载 42%", "", false},
		{"缺右括号", "##[progress 42%", "", false},
		{"缺空格分隔", "##[progress42%]", "", false},
		{"前后有空格", "  ##[progress 42%]  ", "42%", true},
		{"不与 output 协议混淆", "##[output foo=bar]", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			text, ok := parseProgressLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v, want %v", ok, c.wantOK)
			}
			if ok && text != c.wantText {
				t.Fatalf("text = %q, want %q", text, c.wantText)
			}
		})
	}
}
