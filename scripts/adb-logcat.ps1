# adb logcat 抓取到本地文件，可选按 包名 / Tag / 消息关键字 过滤。
# 参数经环境变量注入（见 runner.buildEnv），PowerShell 用 $env: 读取：
#   LOGS_DIR  必填，日志输出目录
#   PACKAGE   可选，包名（自动解析 pid 过滤）
#   TAG       可选，logcat tag，多个空格分隔
#   INCLUDE   可选，消息包含（正则，-match 大小写不敏感）
#   EXCLUDE   可选，消息排除（正则，-notmatch 大小写不敏感）

$LOGS_DIR   = $env:LOGS_DIR
$TAG        = $env:TAG
$PACKAGE    = $env:PACKAGE
$INCLUDE    = $env:INCLUDE
$EXCLUDE    = $env:EXCLUDE
$filterPid  = $null

$ts  = Get-Date -Format yyyyMMdd_HHmmss
$out = Join-Path $LOGS_DIR "logcat_$ts.log"

# 收集 logcat 源参数
$logcatArgs = @('-v', 'threadtime')
if ($TAG) { ($TAG -split '\s+') | ForEach-Object { $logcatArgs += "${_}:*" } }

# 包名 → pid 过滤：优先 --pid（Android 8+），不支持则降级按 threadtime 第 3 列匹配。
# 注意：$PID 是 PowerShell 自动变量（当前进程 PID），不可复用，故用 $procId。
$usePidFilter = $false
if ($PACKAGE) {
  $procId = (adb shell pidof -s $PACKAGE).Trim()
  if ($procId) {
    if ((adb logcat --help 2>&1) -match '--pid') {
      $logcatArgs += '--pid', $procId
    } else {
      $filterPid = $procId
      $usePidFilter = $true
    }
  } else {
    Write-Output "未找到包进程: $PACKAGE（进程未运行？继续抓全量）"
  }
}

Write-Output "写入: $out"
adb logcat -c 2>$null   # 抓取前清空 logcat 缓冲区，避免混入历史日志
# 关键：必须用单条管道流式落盘——PowerShell 逐行读取 adb 的 stdout 并写文件。
# 严禁 $lines = & adb logcat 再过滤（会阻塞至 logcat 结束，违背流式）。
# Where-Object 条件：参数空时透传（-not $X 短路）；非空时各负其责。
adb logcat @logcatArgs |
    Where-Object { -not $usePidFilter -or ($_.ToString() -split '\s+')[2] -eq $filterPid } |
    Where-Object { -not $INCLUDE       -or $_ -match $INCLUDE } |
    Where-Object { -not $EXCLUDE       -or $_ -notmatch $EXCLUDE } |
    Out-File -FilePath $out -Encoding utf8
