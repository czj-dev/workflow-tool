#!/usr/bin/env python3
"""spm-download 参数解析自查：python3 scripts/test_spm_download.py（全绿则打印 ok）。

文件名带连字符不能直接 import，所以按路径加载模块。
"""
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "spm_download", pathlib.Path(__file__).with_name("spm-download.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# 命令行传参：原样取 argv[1:]，且不得改动入参
argv = ["spm-download.py", "a.zip", "/inner/x.gz"]
assert mod.resolve_args(argv, {}) == ["a.zip", "/inner/x.gz"]
assert argv == ["spm-download.py", "a.zip", "/inner/x.gz"], "resolve_args 不得修改入参"

# script 形态直挂：无参数时从 env 读
assert mod.resolve_args(["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": "/i"}) == [
    "a.zip",
    "/i",
]
assert mod.resolve_args(
    ["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": "/i", "OUT_DIR": "/tmp"}
) == ["a.zip", "/i", "/tmp"]

# 带输出目录的命令行传参
assert mod.resolve_args(["spm-download.py", "a.zip", "/i", "/tmp"], {}) == ["a.zip", "/i", "/tmp"]

# env 路径同样不得修改入参（原实现正是在这条路径上 sys.argv.extend）
env_argv = ["spm-download.py"]
assert mod.resolve_args(env_argv, {"ZIP_NAME": "a.zip", "INNER_PATH": "/i"}) == ["a.zip", "/i"]
assert env_argv == ["spm-download.py"], "resolve_args 不得修改入参"

print("ok")
