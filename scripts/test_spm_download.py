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

# OUT_DIR 空串是表单「留空」的真实形态（不是缺 key），不得追加第三个元素
assert mod.resolve_args(
    ["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": "/i", "OUT_DIR": ""}
) == ["a.zip", "/i"]

# 带输出目录的命令行传参
assert mod.resolve_args(["spm-download.py", "a.zip", "/i", "/tmp"], {}) == ["a.zip", "/i", "/tmp"]

# env 路径同样不得修改入参（原实现正是在这条路径上 sys.argv.extend）
env_argv = ["spm-download.py"]
assert mod.resolve_args(env_argv, {"ZIP_NAME": "a.zip", "INNER_PATH": "/i"}) == ["a.zip", "/i"]
assert env_argv == ["spm-download.py"], "resolve_args 不得修改入参"

# 参数不足/过多 → sys.exit(__doc__)，抛 SystemExit
bad_cases = (
    (["spm-download.py"], {}),  # 无参数且 env 为空
    (["spm-download.py", "a.zip"], {}),  # 只有 2 个
    (["spm-download.py"], {"ZIP_NAME": "a.zip"}),  # env 缺 INNER_PATH
    (["spm-download.py", "a", "b", "c", "d"], {}),  # 5 个，过多
)
for bad_argv, bad_env in bad_cases:
    try:
        mod.resolve_args(bad_argv, bad_env)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"参数个数不对应退出: {bad_argv} env={bad_env}")

print("ok")
