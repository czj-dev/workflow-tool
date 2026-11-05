package actionrun

// MergeParams 合并全局配置与动作参数，参数覆盖同名全局，返回新 map（不改入参）。
// api 直跑路径与 cli 路径共用的单一真相源：api 的 Service 在持锁快照 global 后调用，
// cli 以不可变 global 快照调用。
func MergeParams(global map[string]string, params map[string]any) map[string]any {
	merged := make(map[string]any, len(global)+len(params))
	for k, v := range global {
		merged[k] = v
	}
	for k, v := range params {
		merged[k] = v
	}
	return merged
}
