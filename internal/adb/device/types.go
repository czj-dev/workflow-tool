package device

type Mode string

const (
	ModeADB      Mode = "adb"
	ModeFastboot Mode = "fastboot"
	ModeUnknown  Mode = "unknown"
)

type State string

const (
	StateReady        State = "device"
	StateOffline      State = "offline"
	StateUnauthorized State = "unauthorized"
	StateRecovery     State = "recovery"
	StateSideload     State = "sideload"
	StateFastboot     State = "fastboot"
	StateUnknown      State = "unknown"
)

// Summary 是 adb/fastboot devices 的单行摘要。
type Summary struct {
	Serial      string `json:"serial"`
	State       State  `json:"state"`
	Mode        Mode   `json:"mode"`
	Product     string `json:"product,omitempty"`
	Model       string `json:"model,omitempty"`
	Device      string `json:"device,omitempty"`
	TransportID string `json:"transportId,omitempty"`
}

// Info 是单设备的详细信息（含 getprop/dumpsys 解析结果）。
type Info struct {
	Serial          string `json:"serial"`
	State           State  `json:"state"`
	Mode            Mode   `json:"mode"`
	Product         string `json:"product,omitempty"`
	Model           string `json:"model,omitempty"`
	Device          string `json:"device,omitempty"`
	Brand           string `json:"brand,omitempty"`
	Codename        string `json:"codename,omitempty"`
	Manufacturer    string `json:"manufacturer,omitempty"`
	AndroidVersion  string `json:"androidVersion,omitempty"`
	SDKVersion      string `json:"sdkVersion,omitempty"`
	BuildID         string `json:"buildId,omitempty"`
	SecurityPatch   string `json:"securityPatch,omitempty"`
	ABIs            string `json:"abis,omitempty"`
	TransportID     string `json:"transportId,omitempty"`
	ConnectionLabel string `json:"connectionLabel,omitempty"`
	IPAddress       string `json:"ipAddress,omitempty"`
	RootStatus      string `json:"rootStatus,omitempty"`
	BatteryLevel    string `json:"batteryLevel,omitempty"`
	StorageInfo     string `json:"storageInfo,omitempty"`
	RAMTotal        string `json:"ramTotal,omitempty"`
}
