package runner

import (
	"encoding/json"
	"testing"
)

func TestWithoutTreeHMIEmitsOrdinaryText(t *testing.T) {
	for _, tc := range []struct{ protocol, want string }{
		{"script", `##[tree {"nodes":[]}]`},
		{"adb", `{"nodes":[]}`},
	} {
		var gotStream, gotLine string
		WithoutTreeHMI(func(stream, line string) { gotStream, gotLine = stream, line }, tc.protocol)("tree", `{"nodes":[]}`)
		if gotStream != "stdout" || gotLine != tc.want {
			t.Fatalf("%s: got %s %q", tc.protocol, gotStream, gotLine)
		}
	}
}

func TestWithTreeSourcePreservesFrameAndOtherStreams(t *testing.T) {
	var gotStream, gotLine string
	emit := WithTreeSource(func(stream, line string) { gotStream, gotLine = stream, line }, TreeSource{
		ActionID: "browse", Params: map[string]any{"ZIP_NAME": "logs.zip"}, Protocol: "script",
	})
	emit("tree", `{"nodes":[{"label":"log.txt","path":"a/log.txt"}]}`)
	var frame struct {
		Nodes  []struct{ Path string `json:"path"` } `json:"nodes"`
		Source TreeSource `json:"source"`
	}
	if err := json.Unmarshal([]byte(gotLine), &frame); err != nil {
		t.Fatal(err)
	}
	if gotStream != "tree" || frame.Nodes[0].Path != "a/log.txt" || frame.Source.Params["ZIP_NAME"] != "logs.zip" {
		t.Fatalf("unexpected tree frame: %s %s", gotStream, gotLine)
	}
	emit("stdout", "plain text")
	if gotStream != "stdout" || gotLine != "plain text" {
		t.Fatalf("other stream changed: %s %s", gotStream, gotLine)
	}
}
