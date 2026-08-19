// Package builtinvars 统一管理内置变量（CURRENT_DATE/CURRENT_TIME/ADB_SERIAL），
// 供 runner.Expand 在 params/环境变量都未命中时兜底查询。
// 新增内置变量只需在 Resolve 的 switch 里加一个 case，不改动调用方。
package builtinvars

import (
	"context"
	"strconv"
	"time"
)

// DeviceResolver 是 ADB_SERIAL 解析所需的最小设备查询能力
// （*device.Service 实现；单独定义避免本包依赖 adb/device，防止循环依赖）。
type DeviceResolver interface {
	ResolveActive(ctx context.Context) (string, error)
}

// Registry 持有内置变量解析所需的依赖（目前只有 ADB_SERIAL 需要设备服务）。
type Registry struct {
	dev DeviceResolver
}

// New 创建 Registry。dev 为 nil 时 ADB_SERIAL 解析恒为未命中（其余变量不受影响）。
func New(dev DeviceResolver) *Registry {
	return &Registry{dev: dev}
}

// Resolve 返回 name 对应的内置变量值。ok=false 表示 name 不是已注册的内置变量，
// 或是但当前解析失败（如无在线设备）——调用方应继续走下一优先级（环境变量）。
// receiver 为 nil 时安全返回 ("", false)，兼容未注入 builtins 的调用点。
func (r *Registry) Resolve(ctx context.Context, name string) (string, bool) {
	if r == nil {
		return "", false
	}
	switch name {
	case "CURRENT_DATE":
		return time.Now().Format("20060102"), true
	case "CURRENT_TIME":
		return strconv.FormatInt(time.Now().UnixMilli(), 10), true
	case "ADB_SERIAL":
		if r.dev == nil {
			return "", false
		}
		serial, err := r.dev.ResolveActive(ctx)
		if err != nil || serial == "" {
			return "", false
		}
		return serial, true
	default:
		return "", false
	}
}
