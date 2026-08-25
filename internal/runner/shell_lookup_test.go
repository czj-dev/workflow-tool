package runner

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeLookup 构造可控的 PATH 查找：hits 命中返回路径，其余报错。
func fakeLookup(hits map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if p, ok := hits[name]; ok {
			return p, nil
		}
		return "", fmt.Errorf("not found: %s", name)
	}
}

func TestLookupPosixShell_OverrideWins(t *testing.T) {
	// validate 是恒 nil 的 stub，不看真实文件，所以这里只需要一个路径字符串。
	override := filepath.Join(t.TempDir(), "mybash.exe")
	lookup := posixShellLookup{
		lookPath: fakeLookup(nil), // PATH 什么都找不到，也不该被用到
		validate: func(p string) error { return nil },
		dirs:     nil,
	}
	got, err := lookupPosixShell("bash", override, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if got != override {
		t.Fatalf("got %q, want override %q", got, override)
	}
}

func TestLookupPosixShell_WSLBashExcluded(t *testing.T) {
	lookup := posixShellLookup{
		lookPath: fakeLookup(map[string]string{
			"bash": `C:\Windows\System32\bash.exe`, // PATH 命中的是 WSL 入口，必须跳过
		}),
		validate: func(p string) error { return nil },
		dirs:     []string{`C:\Program Files\Git\bin`},
	}
	got, err := lookupPosixShell("bash", "", lookup)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(`C:\Program Files\Git\bin`, "bash.exe")
	if got != want {
		t.Fatalf("应回退到常见 Git 安装目录, got %q, want %q", got, want)
	}
}

func TestLookupPosixShell_NotFound(t *testing.T) {
	lookup := posixShellLookup{
		lookPath: fakeLookup(nil),
		validate: func(p string) error { // 模拟 exec.LookPath：文件不存在即报错
			if _, err := os.Stat(p); err != nil {
				return err
			}
			return nil
		},
		dirs: []string{`X:\nowhere`},
	}
	_, err := lookupPosixShell("bash", "", lookup)
	if err == nil {
		t.Fatal("全找不到应报错")
	}
	if !strings.Contains(err.Error(), "Git for Windows") {
		t.Fatalf("报错应含安装指引: %v", err)
	}
}

func TestResolveInterpreter_UnknownNamePassesThrough(t *testing.T) {
	// 非内置逻辑名（powershell / node / cmd / 自定义模板首元素）不做任何映射，
	// 原样返回交给 exec 解析——两个平台的 default 分支行为一致。
	got, err := resolveInterpreter("powershell", "")
	if err != nil {
		t.Fatal(err)
	}
	if got != "powershell" {
		t.Fatalf("powershell 名应原样返回, got %q", got)
	}
}
