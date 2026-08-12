package device

import (
	"context"
	"log"
	"sync"

	"workflow-tool/internal/adb/binary"
	"workflow-tool/internal/adbcore"
)

// Service 管理设备列表与激活设备 serial。
type Service struct {
	getPaths func() binary.Paths
	mu       sync.Mutex
	active   string
}

// NewService 构造设备服务。getPaths 返回当前解析到的 adb/fastboot 路径。
func NewService(getPaths func() binary.Paths) *Service {
	return &Service{getPaths: getPaths}
}

// ListDevices 合并 adb 与 fastboot 设备。fastboot 常未装，其失败仅记日志，
// 仅当两者都失败才返回错误（避免把真实问题伪装成「无设备」）。
func (s *Service) ListDevices(ctx context.Context) ([]Summary, error) {
	adbDevices, adbErr := s.listADBDevices(ctx)
	fastbootDevices, fastbootErr := s.listFastbootDevices(ctx)

	if adbErr != nil && fastbootErr != nil {
		return nil, adbErr
	}
	if adbErr != nil {
		log.Printf("device: adb listing failed: %v", adbErr)
	}
	if fastbootErr != nil {
		log.Printf("device: fastboot listing failed: %v", fastbootErr)
	}

	devices := make([]Summary, 0, len(adbDevices)+len(fastbootDevices))
	devices = append(devices, adbDevices...)
	devices = append(devices, fastbootDevices...)
	return devices, nil
}

// GetDeviceInfo 返回单设备的详细信息（含 getprop/dumpsys 解析）。
func (s *Service) GetDeviceInfo(ctx context.Context, serial string) (*Info, error) {
	devices, err := s.ListDevices(ctx)
	if err != nil {
		return nil, err
	}

	var matched *Summary
	for i := range devices {
		if devices[i].Serial == serial {
			matched = &devices[i]
			break
		}
	}
	if matched == nil {
		return nil, adbcore.NewOperationError("get_device_info", "device was not found", "serial '"+serial+"' is not connected", true)
	}

	info := &Info{
		Serial:      matched.Serial,
		State:       matched.State,
		Mode:        matched.Mode,
		Product:     matched.Product,
		Model:       matched.Model,
		Device:      matched.Device,
		TransportID: matched.TransportID,
	}

	if matched.Mode != ModeADB || matched.State != StateReady {
		info.ConnectionLabel = string(matched.Mode)
		return info, nil
	}

	if props, err := s.getDeviceProperties(ctx, matched.Serial); err == nil {
		info.Manufacturer = props["ro.product.manufacturer"]
		info.Brand = props["ro.product.brand"]
		info.AndroidVersion = props["ro.build.version.release"]
		info.SDKVersion = props["ro.build.version.sdk"]
		info.BuildID = props["ro.build.display.id"]
		info.SecurityPatch = props["ro.build.version.security_patch"]
		info.ABIs = props["ro.product.cpu.abilist"]
		info.ConnectionLabel = props["ro.product.name"]
		info.Codename = props["ro.product.device"]
		if info.Product == "" {
			info.Product = props["ro.product.name"]
		}
		if info.Model == "" {
			info.Model = props["ro.product.model"]
		}
		if info.Device == "" {
			info.Device = props["ro.product.device"]
		}
		info.IPAddress = extractDeviceIPAddress(props)
		info.RootStatus = extractRootStatus(props)
	}
	if v, err := s.getBatteryLevel(ctx, matched.Serial); err == nil {
		info.BatteryLevel = v
	}
	if v, err := s.getStorageInfo(ctx, matched.Serial); err == nil {
		info.StorageInfo = v
	}
	if v, err := s.getRAMTotal(ctx, matched.Serial); err == nil {
		info.RAMTotal = v
	}
	return info, nil
}

// SetActive 设置激活设备 serial（前端设备选择器调用）。
func (s *Service) SetActive(serial string) {
	s.mu.Lock()
	s.active = serial
	s.mu.Unlock()
}

// ActiveSerial 返回当前激活设备 serial（可能为 ""）。
func (s *Service) ActiveSerial() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}

// IsReady 报告 serial 当前是否在线且处于 ready（可执行 adb 命令）状态。
// 用于校验注入的 ADB_SERIAL 是否仍有效：车载/网络设备重连后 transport serial 可能变化，
// 缓存的 serial 会失效，此时应重新解析而非盲目传给 adb（否则 adb -s <失效serial> 无限 waiting）。
func (s *Service) IsReady(ctx context.Context, serial string) bool {
	if serial == "" {
		return false
	}
	devices, err := s.ListDevices(ctx)
	if err != nil {
		return false
	}
	for _, d := range devices {
		if d.Serial == serial {
			return d.State == StateReady
		}
	}
	return false
}

// ResolveActive 返回应使用的设备 serial：激活设备仍在线且 ready 则用它，
// 否则在当前设备里选第一个 ready 的 adb 设备并记为激活。无可用设备返回 ""。
func (s *Service) ResolveActive(ctx context.Context) (string, error) {
	devices, err := s.ListDevices(ctx)
	if err != nil {
		return s.ActiveSerial(), err
	}
	active := s.ActiveSerial()
	for _, d := range devices {
		if active != "" && d.Serial == active && d.State == StateReady {
			return active, nil
		}
	}
	for _, d := range devices {
		if d.Mode == ModeADB && d.State == StateReady {
			s.SetActive(d.Serial)
			return d.Serial, nil
		}
	}
	return "", nil
}
