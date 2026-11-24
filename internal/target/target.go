// Package target 定义「目标」：一次运行或一条调度所指的可执行物（见 CONTEXT.md「目标」），
// 动作 / 工作流 / AI 任务三选一。
//
// 它是 schedule（调度指向谁）与 runstore（运行记录记录的是谁）共同的词汇，所以单独
// 成包、被两边依赖：此前两个包各定义一份字符串常量，靠「恰好相等」互认，是隐患。
// 本包不依赖仓库内任何其他包。
package target

// Kind 是目标的种类。
type Kind string

const (
	Action   Kind = "action"
	Workflow Kind = "workflow"
	AI       Kind = "ai"
)

// Target 是一个目标：种类 + id。同一种类内 id 唯一；不同种类的 id 允许重名，
// 所以只说 id 不够，必须带上种类。
type Target struct {
	Kind Kind   `json:"kind"`
	ID   string `json:"id"`
}

func (k Kind) String() string { return string(k) }
