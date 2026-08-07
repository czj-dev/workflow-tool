package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// shellTimeout 是抓取登录 shell PATH 的超时。登录 shell 会 source 用户全套 dotfile，
// 个别环境（nvm/pyenv/conda 初始化）能拖到 1s 以上，给足余量但不让启动卡死。
const shellTimeout = 3 * time.Second

// FixPath 补全进程 PATH，解决 macOS GUI 启动的 .app 拿不到用户 shell PATH 的问题。
//
// macOS 的 .app 由 launchd 启动，只继承极简 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 不经过 .zshrc/.zprofile，因此 adb / claude / java 这类装在 /usr/local/bin、
// homebrew、Android SDK 下的命令全部 command not found。Windows 的 PATH 存注册表，
// GUI 与控制台进程同源继承，没有这个问题，故非 darwin 直接返回。
//
// 策略与 Electron 生态的 fix-path 一致：spawn 一个登录+交互 shell 抓真实 PATH。
// 抓取失败（shell 异常/超时/非 POSIX shell）时回退硬编码的常见安装位置兜底。
func FixPath() {
	if runtime.GOOS != "darwin" {
		return
	}
	resolved, err := shellPATH()
	if err != nil || strings.TrimSpace(resolved) == "" {
		resolved = fallbackPATH()
	}
	os.Setenv("PATH", mergePaths(resolved, os.Getenv("PATH")))
}

// shellPATH spawn 用户默认 shell 的登录+交互实例，回显展开后的 PATH。
// -i（交互）确保 source .zshrc/.bashrc，-l（登录）确保 source .zprofile/.bash_profile，
// 二者缺一都会漏掉一部分用户配置。
func shellPATH() (string, error) {
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh" // launchd 环境下 SHELL 可能为空；macOS 默认 shell
	}
	ctx, cancel := context.WithTimeout(context.Background(), shellTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, sh, "-ilc", `printf %s "$PATH"`)
	// 抑制 oh-my-zsh 的 tmux 插件在抓取过程中自动起 tmux（会挂住 shell 直到超时）
	cmd.Env = append(os.Environ(), "ZSH_TMUX_AUTOSTARTED=1", "ZSH_TMUX_AUTOSTART=false")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// fallbackPATH 返回常见命令安装位置，用于 shell 抓取失败时兜底。
// 覆盖 homebrew（Intel /usr/local + Apple Silicon /opt/homebrew）、用户级 bin、
// Android SDK platform-tools（adb）。装在非常规路径的命令兜不住，属可接受的降级。
func fallbackPATH() string {
	home, _ := os.UserHomeDir()
	dirs := []string{
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
	}
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "Library", "Android", "sdk", "platform-tools"),
			filepath.Join(home, "go", "bin"),
		)
	}
	return strings.Join(dirs, ":")
}

// mergePaths 把 primary 与 secondary 按序拼接并去重，primary 优先。
// 空段（连续冒号、首尾冒号）被丢弃——PATH 里的空段语义上等于当前目录，是安全隐患。
func mergePaths(primary, secondary string) string {
	seen := make(map[string]bool)
	var out []string
	for _, list := range []string{primary, secondary} {
		for _, dir := range strings.Split(list, ":") {
			if dir == "" || seen[dir] {
				continue
			}
			seen[dir] = true
			out = append(out, dir)
		}
	}
	return strings.Join(out, ":")
}
