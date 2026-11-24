package airun

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// RulesFileName 是无人值守守则的文件名，位于应用目录（可执行文件同级）。
const RulesFileName = "ai-rules.md"

// DefaultRules 是 ai-rules.md 缺失或为空时使用的内置守则（ADR-0007）。
// 只描述运行环境，与任务承担的角色无关——角色与纪律写在任务的 system 里，
// 运行时由 runner 把守则在前、system 在后合成一份系统提示。
var DefaultRules = `# 无人值守守则

你运行在无人值守的 headless 进程里：没有人回答你的提问，也没有人替你确认操作。下面三条描述的是本次运行的环境，与你承担的角色无关。

1. 无人可问，自行决断。需要澄清或确认时不要提问、不要等待，按最可能的理解继续，并在结论中写明你做了哪些假设。
2. 进程退出即任务结束。你只有这一次调用：禁止使用定时唤醒、循环调度、后台子代理等异步续跑机制，它们会让任务被提前判定完成。所有工作必须在当前进程内同步串行完成。
3. 一律使用绝对路径。脚本与命令用绝对路径调用，不依赖当前工作目录，也不要用切换目录代替绝对路径。
`

// LoadRules 读取 baseDir/ai-rules.md 的全文。文件不存在或内容全是空白时用内置默认；
// 其他读取失败（如无权限）记一条 warning 后同样回落——守则读不到不该让运行失败，
// 但要留下痕迹。每次运行前调用，改完文件即生效，不需要重载。
func LoadRules(baseDir string) string {
	path := filepath.Join(baseDir, RulesFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("warning: 读取 %s 失败，改用内置默认守则: %v", path, err)
		}
		return DefaultRules
	}
	if strings.TrimSpace(string(data)) == "" {
		return DefaultRules
	}
	return string(data)
}
