package builtinvars

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"
)

// fakeDev 实现 DeviceResolver，用于测试 ADB_SERIAL 解析。
type fakeDev struct {
	serial string
	err    error
}

func (f *fakeDev) ResolveActive(ctx context.Context) (string, error) {
	return f.serial, f.err
}

func TestResolveCurrentDate(t *testing.T) {
	r := New(nil)
	got, ok := r.Resolve(context.Background(), "CURRENT_DATE")
	if !ok {
		t.Fatal("CURRENT_DATE 应命中")
	}
	want := time.Now().Format("20060102")
	if got != want {
		t.Fatalf("CURRENT_DATE 格式不对，got %q want %q", got, want)
	}
	if len(got) != 8 {
		t.Fatalf("CURRENT_DATE 应为 8 位数字，got %q", got)
	}
}

func TestResolveCurrentTime(t *testing.T) {
	r := New(nil)
	before := time.Now().UnixMilli()
	got, ok := r.Resolve(context.Background(), "CURRENT_TIME")
	after := time.Now().UnixMilli()
	if !ok {
		t.Fatal("CURRENT_TIME 应命中")
	}
	ms, err := strconv.ParseInt(got, 10, 64)
	if err != nil {
		t.Fatalf("CURRENT_TIME 应为纯数字，got %q, err %v", got, err)
	}
	if ms < before || ms > after {
		t.Fatalf("CURRENT_TIME 应落在调用区间内，got %d, range [%d,%d]", ms, before, after)
	}
}

func TestResolveADBSerialHit(t *testing.T) {
	r := New(&fakeDev{serial: "EMULATOR-5554"})
	got, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if !ok || got != "EMULATOR-5554" {
		t.Fatalf("ADB_SERIAL 应命中并返回设备 serial，got %q ok=%v", got, ok)
	}
}

func TestResolveADBSerialNoDevice(t *testing.T) {
	r := New(&fakeDev{serial: "", err: nil})
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("无激活设备时 ADB_SERIAL 应 ok=false")
	}
}

func TestResolveADBSerialResolveError(t *testing.T) {
	r := New(&fakeDev{err: errors.New("adb down")})
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("ResolveActive 出错时 ADB_SERIAL 应 ok=false")
	}
}

func TestResolveADBSerialNilDevResolver(t *testing.T) {
	r := New(nil)
	_, ok := r.Resolve(context.Background(), "ADB_SERIAL")
	if ok {
		t.Fatal("dev 为 nil 时 ADB_SERIAL 应 ok=false（不 panic）")
	}
}

func TestResolveUnknownName(t *testing.T) {
	r := New(nil)
	_, ok := r.Resolve(context.Background(), "SOME_RANDOM_VAR")
	if ok {
		t.Fatal("未注册的变量名应 ok=false")
	}
}

func TestResolveNilRegistry(t *testing.T) {
	var r *Registry
	_, ok := r.Resolve(context.Background(), "CURRENT_DATE")
	if ok {
		t.Fatal("nil *Registry 应安全返回 ok=false，不 panic")
	}
}
