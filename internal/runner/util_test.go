package runner

import "testing"

func TestCapBuffer_UnderLimit(t *testing.T) {
	c := newCapBuffer(100)
	c.WriteLine("hello")
	c.WriteLine("world")
	got := c.String()
	want := "hello\nworld\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestCapBuffer_OverLimit_KeepsTail(t *testing.T) {
	c := newCapBuffer(10)
	c.WriteLine("0123456789") // 11 bytes（含\n），已超限 -> 截断保留尾部10字节 "123456789\n"
	c.WriteLine("abcde")      // 追加 "abcde\n"(6字节) 后共16字节，再截断保留尾部10字节
	got := c.String()
	if len(got) != 10 {
		t.Fatalf("len(got)=%d want 10, got=%q", len(got), got)
	}
	if got != "789\nabcde\n" {
		t.Fatalf("got %q want %q", got, "789\nabcde\n")
	}
}

func TestCapBuffer_Nil_Safe(t *testing.T) {
	var c *capBuffer
	c.WriteLine("noop") // 不应 panic
	if got := c.String(); got != "" {
		t.Fatalf("got %q want empty", got)
	}
}
