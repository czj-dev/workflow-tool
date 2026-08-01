$apk = Get-ChildItem -Path $env:VOICE_DEBUG_OUTPUT -Filter *.apk -File | Select-Object -First 1
if ($apk) {
  Write-Output "安装: $($apk.FullName)"
  adb install -t -r -d $apk.FullName
} else {
  Write-Output "未找到 APK: $env:VOICE_DEBUG_OUTPUT"
  exit 1
}
