package input

import "testing"

func TestPlanInput(t *testing.T) {
	cases := []struct {
		name string
		text string
		clip bool
	}{
		{"pure ascii", "hello", false},
		{"ascii with spaces", "hello world 123", false},
		{"digits and punctuation", "a=b-1_2.3", false},
		{"chinese", "你好", true},
		{"mixed", "abc你好", true},
		{"emoji", "ok👍", true},
		{"newline", "a\nb", true},
		{"carriage return", "a\rb", true},
		{"tab", "a\tb", true},
	}
	for _, c := range cases {
		if got := planInput(c.text); got.UseClipboard != c.clip {
			t.Errorf("%s: planInput(%q).UseClipboard = %v, want %v", c.name, c.text, got.UseClipboard, c.clip)
		}
	}
}

func TestEscapeForInputText(t *testing.T) {
	if got, want := escapeForInputText("hello world"), "hello%sworld"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
	if got, want := escapeForInputText("a  b"), "a%s%sb"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
	if got, want := escapeForInputText("nospace"), "nospace"; got != want {
		t.Errorf("escapeForInputText = %q, want %q", got, want)
	}
}
