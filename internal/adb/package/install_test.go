package packagemgr

import "testing"

// TestInstallReportsSuccess 覆盖 adb install 输出 → 成功/失败判定的核心边界。
// 动机：老实现只看 exitCode==0，但 PTY / 旧 adb 偶现 exit=0 且输出 "Failure [...]"，
// 造成 workflow "install 失败但显示成功"。这里锁死以 Success/Failure 关键字为准。
func TestInstallReportsSuccess(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{
			name:   "streamed install success",
			output: "Performing Streamed Install\nSuccess\n",
			want:   true,
		},
		{
			name:   "success with progress noise",
			output: "[  0%] /data/local/tmp/x.apk\n[100%] /data/local/tmp/x.apk\nSuccess\n",
			want:   true,
		},
		{
			name:   "failure with older sdk",
			output: "Performing Streamed Install\nFailure [INSTALL_FAILED_OLDER_SDK]\n",
			want:   false,
		},
		{
			name:   "failure trumps stray success substring",
			output: "Successfully paired\nFailure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n",
			want:   false,
		},
		{
			name:   "empty output means not success",
			output: "",
			want:   false,
		},
		{
			name:   "only progress lines is not success",
			output: "[  0%] /data/local/tmp/x.apk\n[100%] /data/local/tmp/x.apk\n",
			want:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := installReportsSuccess(tc.output)
			if got != tc.want {
				t.Fatalf("installReportsSuccess(%q) = %v, want %v", tc.output, got, tc.want)
			}
		})
	}
}

// TestExtractInstallFailure 验证失败原因抽取——UI 上显示这行给用户看。
func TestExtractInstallFailure(t *testing.T) {
	got := extractInstallFailure("Performing Streamed Install\nFailure [INSTALL_FAILED_OLDER_SDK]\n")
	want := "Failure [INSTALL_FAILED_OLDER_SDK]"
	if got != want {
		t.Fatalf("extractInstallFailure = %q, want %q", got, want)
	}
	if extractInstallFailure("Success\n") != "" {
		t.Fatalf("extractInstallFailure on success should return empty")
	}
}

// TestInstallProgressPattern 验证进度行正则匹配 adb 实际输出格式 "[  5%] ..."。
func TestInstallProgressPattern(t *testing.T) {
	cases := []struct {
		line    string
		matches bool
		pct     string
	}{
		{"[  5%] /data/local/tmp/x.apk", true, "5"},
		{"[100%] /data/local/tmp/x.apk", true, "100"},
		{"[ 45%]", true, "45"},
		{"Performing Streamed Install", false, ""},
		{"Success", false, ""},
	}
	for _, tc := range cases {
		m := installProgressPattern.FindStringSubmatch(tc.line)
		gotMatched := len(m) > 1
		if gotMatched != tc.matches {
			t.Fatalf("line %q: match=%v want=%v", tc.line, gotMatched, tc.matches)
		}
		if gotMatched && m[1] != tc.pct {
			t.Fatalf("line %q: pct=%q want=%q", tc.line, m[1], tc.pct)
		}
	}
}
