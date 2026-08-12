package adb

import (
	"context"
	"errors"
	"testing"
)

// fakeDev 实现 deviceResolver，按预设值返回，便于测试 resolveSerial 的决策逻辑。
type fakeDev struct {
	ready   map[string]bool // serial -> 是否在线 ready
	resolve string          // ResolveActive 返回值
	resolveErr error
}

func (f *fakeDev) ResolveActive(ctx context.Context) (string, error) {
	return f.resolve, f.resolveErr
}

func (f *fakeDev) IsReady(ctx context.Context, serial string) bool {
	return f.ready[serial]
}

// 注入的 ADB_SERIAL 仍在线 → 沿用，不调用 ResolveActive（尊重 UI 选择/config 显式 pin）。
func TestResolveSerialKeepsValidInjectedSerial(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{"DEVICE_A": true}, resolve: "DEVICE_B"}
	got := resolveSerial(context.Background(), dev, "DEVICE_A")
	if got != "DEVICE_A" {
		t.Fatalf("在线 serial 应沿用，got %q", got)
	}
}

// 注入的 ADB_SERIAL 已失效（设备重连换了 transport serial）→ 回退 ResolveActive。
// 这是 - waiting for device - 的根因场景。
func TestResolveSerialFallsBackWhenStale(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{"OLD_SERIAL": false}, resolve: "NEW_SERIAL"}
	got := resolveSerial(context.Background(), dev, "OLD_SERIAL")
	if got != "NEW_SERIAL" {
		t.Fatalf("失效 serial 应回退到 ResolveActive，got %q", got)
	}
}

// 无注入 serial（首次启动未选设备）→ ResolveActive 自动选首个 ready。
func TestResolveSerialResolvesWhenEmpty(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{}, resolve: "AUTO_PICKED"}
	got := resolveSerial(context.Background(), dev, "")
	if got != "AUTO_PICKED" {
		t.Fatalf("空 serial 应 ResolveActive，got %q", got)
	}
}

// ResolveActive 出错（adb 不可用等）→ 保留原 paramSerial，由下游 adb 自行报错而非空指针。
func TestResolveSerialKeepsParamOnResolveError(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{"X": false}, resolveErr: errors.New("adb down")}
	got := resolveSerial(context.Background(), dev, "X")
	if got != "X" {
		t.Fatalf("ResolveActive 出错应保留 paramSerial，got %q", got)
	}
}

// ResolveActive 返回空（无任何 ready 设备）→ 保留原 paramSerial（可能仍有效但 IsReady 误判）。
func TestResolveSerialKeepsParamWhenNoDevice(t *testing.T) {
	dev := &fakeDev{ready: map[string]bool{"X": false}, resolve: ""}
	got := resolveSerial(context.Background(), dev, "X")
	if got != "X" {
		t.Fatalf("无可用设备时应保留 paramSerial，got %q", got)
	}
}

// dev 为 nil（无设备服务）→ 直接透传 paramSerial，不 panic。
func TestResolveSerialNilDevPassthrough(t *testing.T) {
	got := resolveSerial(context.Background(), nil, "ANY")
	if got != "ANY" {
		t.Fatalf("nil dev 应透传 paramSerial，got %q", got)
	}
}
