package runner

import "encoding/json"

// TreeSource 将树帧绑定到生成它的那次 action 输入，而不改变普通输出事件协议。
type TreeSource struct {
	ActionID string         `json:"actionId"`
	Params   map[string]any `json:"params"`
	Protocol string         `json:"protocol"`
}

// WithTreeSource 仅装饰 tree 帧；无效 JSON 原样转发，交给前端显示解析错误。
func WithoutTreeHMI(emit EmitFunc, protocol string) EmitFunc {
	return func(stream, line string) {
		if stream != "tree" {
			emit(stream, line)
			return
		}
		if protocol == "script" {
			line = "##[tree " + line + "]"
		}
		emit("stdout", line)
	}
}

func WithTreeSource(emit EmitFunc, source TreeSource) EmitFunc {
	return func(stream, line string) {
		if stream != "tree" {
			emit(stream, line)
			return
		}
		var frame map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &frame); err != nil || frame == nil {
			emit(stream, line)
			return
		}
		encoded, err := json.Marshal(source)
		if err != nil {
			emit(stream, line)
			return
		}
		frame["source"] = encoded
		out, err := json.Marshal(frame)
		if err != nil {
			emit(stream, line)
			return
		}
		emit(stream, string(out))
	}
}
