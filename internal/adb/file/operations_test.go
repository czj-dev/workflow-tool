package file

import "testing"

// fixture 取自 toybox `ls -lAL` 形态：目录/普通文件/符号链接/隐藏项各一。
const lsOutputFixture = `total 4
drwxrwx--x 4 root sdcard 4096 2026-09-05 11:02 Android
-rw-rw---- 1 root sdcard 1456312 2026-09-05 17:02 screenshot_0905_170216.png
lrwxrwxrwx 1 root sdcard 21 2026-09-01 09:00 link -> target.txt
drwxrwx--x 2 root sdcard 4096 2026-09-04 10:00 .hiddendir
`

func TestListFilesTree(t *testing.T) {
	entries, err := parseFileListOutput(lsOutputFixture, "/sdcard/", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 { // 隐藏目录被滤掉
		t.Fatalf("entries = %+v", entries)
	}
	root := listFilesTree("/sdcard/", entries)
	if root.Label != "/sdcard/" || root.Kind != "dir" || root.Path != "/sdcard/" {
		t.Fatalf("root = %+v", root)
	}
	if len(root.Children) != 3 {
		t.Fatalf("children = %+v", root.Children)
	}
	dir := root.Children[0]
	if dir.Label != "Android" || dir.Kind != "dir" || dir.Path != "/sdcard/Android" || dir.Detail != "" {
		t.Fatalf("dir = %+v", dir)
	}
	file := root.Children[1]
	if file.Kind != "file" || file.Path != "/sdcard/screenshot_0905_170216.png" {
		t.Fatalf("file = %+v", file)
	}
	if file.Detail != "1.4 MB · 2026-09-05 17:02" {
		t.Fatalf("file detail = %q", file.Detail)
	}
	// 符号链接单独标记，目标在属性面板中展示。
	link := root.Children[2]
	if link.Label != "link" || link.Kind != "symlink" || link.Properties["target"] != "target.txt" {
		t.Fatalf("link = %+v", link)
	}
}

func TestListFilesTreeEmpty(t *testing.T) {
	root := listFilesTree("/sdcard/empty", nil)
	if len(root.Children) != 0 {
		t.Fatalf("children = %+v", root.Children)
	}
}

func TestParseFileListLinePreservesNames(t *testing.T) {
	cases := []struct {
		line, name, target, modified string
	}{
		{"-rw-r--r-- 1 root root 2 2026-09-05 11:02 two  spaces.txt ", "two  spaces.txt ", "", "2026-09-05 11:02"},
		{"lrwxrwxrwx 1 root root 1 2026-09-05 11:02 link -> a -> b", "link", "a -> b", "2026-09-05 11:02"},
		{"crw------- 1 root root 1, 3 2026-09-05 11:02 null", "null", "", "2026-09-05 11:02"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry, ok, err := parseFileListLine(tc.line, "/dev")
			if err != nil || !ok || entry.Name != tc.name || entry.LinkTarget != tc.target || entry.ModifiedAt != tc.modified {
				t.Fatalf("entry=%+v ok=%t err=%v", entry, ok, err)
			}
		})
	}
}
