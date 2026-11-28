package actionrun

// MergeParams 合并全局配置与动作参数，参数覆盖同名全局，返回新 map（不改入参）。
// api 直跑路径与 cli 路径共用的单一真相源：api 的 Service 在持锁快照 global 后调用，
// cli 以不可变 global 快照调用。
// global 应是已解析的终值：调用前先过 runner.ResolveGlobal 展开 config 层的嵌套引用
//（api/cli 的 merge 入口已做），用户 params 保持数据语义不做解析。
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
