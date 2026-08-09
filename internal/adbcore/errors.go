package adbcore

// OperationError 是任意 adb 域操作的结构化错误。
// 保留 ADBKit 的结构以便上层判断 Retryable 与展示 Detail。
type OperationError struct {
	Operation string `json:"operation"`
	Message   string `json:"message"`
	Detail    string `json:"detail,omitempty"`
	Retryable bool   `json:"retryable"`
}

func (e *OperationError) Error() string {
	if e.Detail != "" {
		return e.Operation + ": " + e.Message + " (" + e.Detail + ")"
	}
	return e.Operation + ": " + e.Message
}

// NewOperationError 构造一个 OperationError。
func NewOperationError(op, msg, detail string, retryable bool) *OperationError {
	return &OperationError{
		Operation: op,
		Message:   msg,
		Detail:    detail,
		Retryable: retryable,
	}
}

// BinaryStatus 描述一个外部二进制的就绪状态。
type BinaryStatus string

const (
	BinaryMissing BinaryStatus = "missing"
	BinaryInvalid BinaryStatus = "invalid_path"
	BinaryReady   BinaryStatus = "ready"
)

// BinaryInfo 描述一个被探测到的二进制候选。
type BinaryInfo struct {
	Name    string       `json:"name"`
	Path    string       `json:"path"`
	Source  string       `json:"source"`
	Status  BinaryStatus `json:"status"`
	Version string       `json:"version,omitempty"`
	Reason  string       `json:"reason,omitempty"`
}
