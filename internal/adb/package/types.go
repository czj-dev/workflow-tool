package packagemgr

// pkgFilter 是 list-packages 的范围筛选。
type pkgFilter string

const (
	filterUser   pkgFilter = "user"
	filterSystem pkgFilter = "system"
	filterAll    pkgFilter = "all"
)

// pkgInfo 是单个包的列表项。
type pkgInfo struct {
	PackageName string
	IsEnabled   bool
	IsSystemApp bool
}

// pkgDetails 是 package-details 的结构化结果，用于格式化输出。
type pkgDetails struct {
	PackageName    string
	VersionName    string
	VersionCode    string
	ApkSizeBytes   int64
	DataSizeBytes  int64
	TotalSizeBytes int64
}
