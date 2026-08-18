package api

import (
	"context"

	"workflow-tool/internal/adb/device"
)

// DeviceListResult 包装设备列表与激活 serial。
type DeviceListResult struct {
	Devices []device.Summary `json:"devices"`
	Active  string           `json:"active"`
}

// ListDevices 返回当前 adb/fastboot 设备列表 + 激活 serial（无激活时自动选首个 ready）。
func (s *Service) ListDevices() DeviceListResult {
	ctx := context.Background()
	devices, err := s.dev.ListDevices(ctx)
	if err != nil {
		return DeviceListResult{}
	}
	active, _ := s.dev.ResolveActive(ctx)
	return DeviceListResult{Devices: devices, Active: active}
}

// GetDeviceInfo 返回单设备的详细信息（含 getprop/dumpsys 解析，见 device.Service）。
func (s *Service) GetDeviceInfo(serial string) (*device.Info, error) {
	return s.dev.GetDeviceInfo(context.Background(), serial)
}

// SetActiveDevice 设置激活设备 serial（前端设备选择器调用）。
func (s *Service) SetActiveDevice(serial string) {
	s.dev.SetActive(serial)
}
