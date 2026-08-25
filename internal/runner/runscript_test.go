package runner

import (
	"os"
	"strings"
	"testing"
)

func TestWriteRunScript_ForcesLF(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo a\r\necho b\r\n")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\r") {
		t.Fatalf("临时脚本必须 LF 行尾, got %q", data)
	}
	if string(data) != "echo a\necho b\n" {
		t.Fatalf("内容异常: %q", data)
	}
}

// TestWriteRunScript_ForcesLF_LoneCR 孤立 \r（老式 Mac 行尾 / 粘贴进 YAML 的回车）
// 也必须归一为 LF——bash 会把 \r 算进命令名，报 $'\r': command not found。
func TestWriteRunScript_ForcesLF_LoneCR(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo a\recho b")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "\r") {
		t.Fatalf("孤立 \\r 必须归一为 LF, got %q", data)
	}
	if string(data) != "echo a\necho b\n" {
		t.Fatalf("内容异常: %q", data)
	}
}

func TestWriteRunScript_PwshWrapping(t *testing.T) {
	spec, _ := LookupShellSpec("pwsh")
	path, cleanup, err := writeRunScript(spec, "Write-Output hi")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	if lines[0] != pwshWrapHead {
		t.Fatalf("首行应为 WrapHead: %q", lines[0])
	}
	if lines[len(lines)-1] != pwshWrapTail {
		t.Fatalf("末行应为 WrapTail: %q", lines[len(lines)-1])
	}
	if !strings.Contains(s, "Write-Output hi") {
		t.Fatalf("原始内容丢失: %q", s)
	}
}

func TestWriteRunScript_CleanupRemovesFile(t *testing.T) {
	spec, _ := LookupShellSpec("bash")
	path, cleanup, err := writeRunScript(spec, "echo hi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("cleanup 应删除临时文件 %s", path)
	}
}

func TestWriteRunScript_ExtSuffix(t *testing.T) {
	for _, name := range []string{"bash", "python", "node", "pwsh"} {
		spec, _ := LookupShellSpec(name)
		path, cleanup, err := writeRunScript(spec, "x")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasSuffix(path, spec.Ext) {
			t.Errorf("%s 临时文件应以 %s 结尾: %s", name, spec.Ext, path)
		}
		cleanup()
	}
}
