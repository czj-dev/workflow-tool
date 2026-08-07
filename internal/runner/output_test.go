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
