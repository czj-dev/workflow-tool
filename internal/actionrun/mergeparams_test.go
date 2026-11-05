package actionrun

import (
	"reflect"
	"testing"
)

func TestMergeParams(t *testing.T) {
	global := map[string]string{"A": "g", "B": "g"}
	params := map[string]any{"B": "p", "C": true}

	got := MergeParams(global, params)
	want := map[string]any{"A": "g", "B": "p", "C": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("参数应覆盖同名全局，want %v got %v", want, got)
	}

	// 不得改动入参。
	if global["B"] != "g" {
		t.Fatalf("global 被污染：%v", global)
	}
}
