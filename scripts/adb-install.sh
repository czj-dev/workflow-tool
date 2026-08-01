#!/bin/sh
APK=$(find "${VOICE_DEBUG_OUTPUT}" -maxdepth 1 -name "*.apk" | head -1)
if [ -n "$APK" ]; then
  echo "安装: $APK"
  adb install -t -r -d "$APK"
else
  echo "未找到 APK: ${VOICE_DEBUG_OUTPUT}"
  exit 1
fi
