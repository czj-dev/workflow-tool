package device

import "testing"

// 车载/网络 ADB 设备的 serial 常带 _ANDROID 后缀且含下划线，确认 parseADBDevices 正确解析
// （serial 取首列、state=device→StateReady、-l 的键值对不破坏解析）。
// 复现用户设备：07ab9620cb257222_ANDROID。
func TestParseADBDevicesAutomotiveSerial(t *testing.T) {
	out := "List of devices attached\n" +
		"07ab9620cb257222_ANDROID device usb:1310720X product:vext_wt_car model:DP8678GRP device:auto8678p1_64_bsp_vm_uos transport_id:9\n"
	got := parseADBDevices(out)
	if len(got) != 1 {
		t.Fatalf("want 1 device, got %d: %+v", len(got), got)
	}
	d := got[0]
	if d.Serial != "07ab9620cb257222_ANDROID" {
		t.Errorf("Serial = %q", d.Serial)
	}
	if d.State != StateReady {
		t.Errorf("State = %v, want StateReady(device)", d.State)
	}
	if d.Mode != ModeADB {
		t.Errorf("Mode = %v, want ModeADB", d.Mode)
	}
	if d.Product != "vext_wt_car" {
		t.Errorf("Product = %q", d.Product)
	}
	if d.TransportID != "9" {
		t.Errorf("TransportID = %q", d.TransportID)
	}
}

func TestParseADBDevicesSkipsHeaderAndBlank(t *testing.T) {
	out := "List of devices attached\n\n  \n12345 device\n"
	got := parseADBDevices(out)
	if len(got) != 1 || got[0].Serial != "12345" {
		t.Fatalf("应只解析 1 个设备，got %+v", got)
	}
}

func TestParseADBDevicesUnrecognizedState(t *testing.T) {
	got := parseADBDevices("List of devices attached\nabc weirdstate\n")
	if len(got) != 1 || got[0].State != StateUnknown {
		t.Fatalf("未识别 state 应回退 StateUnknown，got %+v", got)
	}
}
