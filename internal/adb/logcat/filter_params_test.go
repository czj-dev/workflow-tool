package logcat

import "testing"

func TestBuildFilterTagJSON(t *testing.T) {
	f, err := buildFilter("W", `["DVR Alpha","🙂"]`, "hello", "noise")
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{"DVR Alpha", "🙂"} {
		if !f.allow(&Entry{Level: "W", Tag: tag, Message: "hello"}) {
			t.Fatalf("tag %q should match", tag)
		}
	}
	if f.allow(&Entry{Level: "W", Tag: "Alpha", Message: "hello"}) {
		t.Fatal("spaces inside a tag must not split it into multiple matches")
	}
	for _, raw := range []string{"old tag", `["ok",2]`, `null`} {
		if _, err := buildFilter("V", raw, "", ""); err == nil {
			t.Errorf("invalid TAG %q should fail", raw)
		}
	}
	if _, err := buildFilter("V", "", "", ""); err != nil {
		t.Fatalf("empty TAG should allow all: %v", err)
	}
	if _, err := buildFilter("Z", `[]`, "", ""); err == nil {
		t.Fatal("invalid LEVEL should fail")
	}
}

func TestBuildFilterIgnoresEmptyTagRows(t *testing.T) {
	f, err := buildFilter("V", `["", "  ", "Foo"]`, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if f.allow(&Entry{Level: "I", Tag: "Unrelated"}) {
		t.Fatal("empty rows must not match unrelated tags")
	}
	if !f.allow(&Entry{Level: "I", Tag: "MyFoo"}) {
		t.Fatal("non-empty tag should still match")
	}
}
