package runner

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLookupShellSpec_BuiltinBash(t *testing.T) {
	spec, err := LookupShellSpec("bash")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"bash", "--noprofile", "--norc", "-eo", "pipefail", "{0}"}
	if !reflect.DeepEqual(spec.Template, want) {
		t.Fatalf("Template = %v, want %v", spec.Template, want)
	}
	if spec.Ext != ".sh" {
		t.Fatalf("Ext = %q, want .sh", spec.Ext)
	}
}

func TestLookupShellSpec_EmptyDefaultsToBash(t *testing.T) {
	spec, err := LookupShellSpec("")
	if err != nil {
		t.Fatal(err)
	}
	bashSpec, _ := LookupShellSpec("bash")
	if !reflect.DeepEqual(spec, bashSpec) {
		t.Fatalf("空名应等于 bash spec: %+v vs %+v", spec, bashSpec)
	}
}

func TestLookupShellSpec_PwshWrapping(t *testing.T) {
	spec, err := LookupShellSpec("pwsh")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(spec.WrapHead, "$ErrorActionPreference") {
		t.Fatalf("WrapHead 缺 ErrorActionPreference: %q", spec.WrapHead)
	}
	if !strings.Contains(spec.WrapTail, "LASTEXITCODE") {
		t.Fatalf("WrapTail 缺 LASTEXITCODE 传播: %q", spec.WrapTail)
	}
	if spec.Ext != ".ps1" {
		t.Fatalf("Ext = %q, want .ps1", spec.Ext)
	}
	// 必须用 -File 而非 -Command 执行脚本路径：-Command <path> 会吞掉
	// 脚本内 exit $LASTEXITCODE 的退出码（恒为 1），退出码传播语义依赖 -File
	//（真机验收 test-shell-pwsh 抓住的回归，见 spec 验收记录）。
	foundFile := false
	for _, a := range spec.Template {
		if a == "-File" {
			foundFile = true
		}
		if a == "-Command" {
			t.Fatalf("pwsh 模板不应使用 -Command（退出码不传播）: %v", spec.Template)
		}
	}
	if !foundFile {
		t.Fatalf("pwsh 模板缺 -File: %v", spec.Template)
	}
}

// TestPwshExitCodePropagation 端到端验证 pwsh WrapTail 的退出码传播
//（cmd /c exit 5 应传播为脚本退出码 5；本机无 pwsh/powershell 时跳过）。
func TestPwshExitCodePropagation(t *testing.T) {
	_, err := LookupShellSpec("pwsh")
	if err != nil {
		t.Skipf("pwsh spec 不可用: %v", err)
	}
	r := &ShellRunner{Cfg: ShellConfig{
		Run:     "Write-Output \"native fail next\"\ncmd /c exit 5",
		Shell:   "pwsh",
		Timeout: 30 * time.Second,
	}}
	res := r.Run(context.Background(), map[string]any{}, func(string, string) {})
	if res.ExitCode != 5 {
		t.Fatalf("exit = %d, want 5（LASTEXITCODE 传播失败；若本机回退 powershell 5，语义应一致）", res.ExitCode)
	}
}

func TestLookupShellSpec_CmdQuotedPlaceholder(t *testing.T) {
	spec, err := LookupShellSpec("cmd")
	if err != nil {
		t.Fatal(err)
	}
	last := spec.Template[len(spec.Template)-1]
	if !strings.HasPrefix(last, `"`) || !strings.HasSuffix(last, `"`) {
		t.Fatalf("cmd 模板末元素应带引号包裹 {0}: %q", last)
	}
	if !strings.Contains(last, "{0}") {
		t.Fatalf("cmd 模板末元素应含 {0}: %q", last)
	}
}

func TestLookupShellSpec_CustomTemplate(t *testing.T) {
	spec, err := LookupShellSpec("perl -e {0}")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"perl", "-e", "{0}"}
	if !reflect.DeepEqual(spec.Template, want) {
		t.Fatalf("Template = %v, want %v", spec.Template, want)
	}
	if spec.Ext != ".sh" {
		t.Fatalf("自定义模板 Ext 默认 .sh, got %q", spec.Ext)
	}
}

func TestLookupShellSpec_CustomTemplateMissingPlaceholder(t *testing.T) {
	if _, err := LookupShellSpec("perl -e print"); err == nil {
		t.Fatal("不含 {0} 的自定义模板应报错")
	}
}

func TestIsValidShellName(t *testing.T) {
	for _, ok := range []string{"", "bash", "sh", "pwsh", "powershell", "python", "node", "cmd", "perl {0}"} {
		if !IsValidShellName(ok) {
			t.Errorf("IsValidShellName(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"zsh", "perl", "{1}"} {
		if IsValidShellName(bad) {
			t.Errorf("IsValidShellName(%q) = true, want false", bad)
		}
	}
}

func TestShellNameByScript(t *testing.T) {
	cases := map[string]string{
		"foo.sh":     "bash",
		"foo.ps1":    "pwsh",
		"foo.py":     "python",
		"foo.js":     "node",
		"foo.PY":     "python", // 扩展名大小写不敏感
		"./x/foo.sh": "bash",
	}
	for script, want := range cases {
		got, err := ShellNameByScript(script)
		if err != nil {
			t.Errorf("ShellNameByScript(%q) err: %v", script, err)
			continue
		}
		if got != want {
			t.Errorf("ShellNameByScript(%q) = %q, want %q", script, got, want)
		}
	}
	if _, err := ShellNameByScript("foo.rb"); err == nil {
		t.Fatal("未知扩展名应报错")
	}
}
