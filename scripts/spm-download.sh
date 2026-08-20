#!/bin/sh
# 把 action 的 env 参数桥接成 spm-download.py 的 argv（script 形态只认 .sh/.ps1，故需薄壳）。
# OUT_DIR 为空时整个参数省略，让 py 侧回退到 os.getcwd()。
# -u 关掉 stdout 缓冲：管道下 python 默认块缓冲，进度行会攒到退出才一次性吐出。
exec python3 -u "$(dirname "$0")/spm-download.py" "$ZIP_NAME" "$INNER_PATH" ${OUT_DIR:+"$OUT_DIR"}
