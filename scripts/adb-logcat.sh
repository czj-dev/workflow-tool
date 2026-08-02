#!/bin/sh
# adb logcat 抓取到本地文件，可选按 包名 / Tag / 消息关键字 过滤。
# 参数经环境变量注入（见 runner.buildEnv）：
#   LOGS_DIR  必填，日志输出目录
#   PACKAGE   可选，包名（自动解析 pid 过滤）
#   TAG       可选，logcat tag，多个空格分隔
#   INCLUDE   可选，消息包含（正则，大小写不敏感）
#   EXCLUDE   可选，消息排除（正则，大小写不敏感）

TS=$(date +%Y%m%d_%H%M%S)
OUT="${LOGS_DIR}/logcat_${TS}.log"

# 收集 logcat 源参数：-v threadtime + 可选 -s TAG:* + 可选 --pid=PID
set -- -v threadtime
if [ -n "${TAG:-}" ]; then
  for t in $TAG; do set -- "$@" "${t}:*"; done
fi

# 包名 → pid 过滤：优先 --pid（Android 8+），不支持则降级按 threadtime 第 3 列 awk 过滤
USE_PID_FILTER=0
if [ -n "${PACKAGE:-}" ]; then
  PID=$(adb shell pidof -s "${PACKAGE}" | tr -d '\r\n')
  if [ -n "$PID" ]; then
    if adb logcat --help 2>&1 | grep -q -- '--pid'; then
      set -- "$@" --pid="$PID"
    else
      FILTER_PID="$PID"
      USE_PID_FILTER=1
    fi
  else
    echo "未找到包进程: ${PACKAGE}（进程未运行？继续抓全量）" >&2
  fi
fi

# 可选过滤阶段：参数空时 cat 透传，非空时过滤（-i 大小写不敏感，--line-buffered 保证流式）。
# 用 if 分支而非 `grep ... || cat`，避免 grep 无匹配返回非 0 时误走 cat。
stage_pid()     { if [ "$USE_PID_FILTER" -eq 1 ]; then awk -v p="$FILTER_PID" '$3==p'; else cat; fi; }
stage_include() { if [ -n "${INCLUDE:-}" ]; then grep -Ei --line-buffered "$INCLUDE"; else cat; fi; }
stage_exclude() { if [ -n "${EXCLUDE:-}" ]; then grep -v -Ei --line-buffered "$EXCLUDE"; else cat; fi; }

echo "写入: $OUT" >&2
adb logcat "$@" | stage_pid | stage_include | stage_exclude > "$OUT"
