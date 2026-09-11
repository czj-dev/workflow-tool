#!/usr/bin/env python3
"""spm-download 纯函数自查：python3 scripts/test_spm_download.py（全绿则打印 ok）。

覆盖参数解析、片段匹配、零命中退让、浏览树、落盘路径映射、跳过判定六块。
文件名带连字符不能直接 import，所以按路径加载模块。
"""
import importlib.util
import pathlib
import tempfile

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

# 浏览模式：片段可省——命令行 2 个参数，或 env 缺 INNER_PATH / 空串（表单留空注入空串）
assert mod.resolve_args(["spm-download.py", "a.zip"], {}) == ["a.zip"]
assert mod.resolve_args(["spm-download.py"], {"ZIP_NAME": "a.zip"}) == ["a.zip", ""]
assert mod.resolve_args(
    ["spm-download.py"], {"ZIP_NAME": "a.zip", "INNER_PATH": ""}
) == ["a.zip", ""]

# 参数不足/过多 → sys.exit(__doc__)，抛 SystemExit
bad_cases = (
    (["spm-download.py"], {}),  # 无参数且 env 无 ZIP_NAME
    (["spm-download.py", "a", "b", "c", "d"], {}),  # 5 个，过多
)
for bad_argv, bad_env in bad_cases:
    try:
        mod.resolve_args(bad_argv, bad_env)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"参数个数不对应退出: {bad_argv} env={bad_env}")

def entry(path, size=1, is_dir=False):
    return {"path": path, "size": size, "is_directory": is_dir}


A = "resources/debuglogger/mobilelog/APLog_A/main_log_8__2026_0905_170216.gz"
B = "resources/debuglogger/mobilelog/APLog_A/main_log_7__2026_0905_160000.gz"
ENTRIES = [
    entry(A, 6826319),
    entry(B, 100),
    entry("resources/debuglogger/mobilelog/", is_dir=True),
    entry("CLIENT_VER", 2437),
]

# 子串命中唯一目标（验收用例：输入 170216 → main_log_8__2026_0905_170216.gz）
assert [e["path"] for e in mod.match_entries(ENTRIES, "170216")] == [A]

# 大小写不敏感
assert [e["path"] for e in mod.match_entries(ENTRIES, "MAIN_LOG_8")] == [A]

# 多命中按 path 字典序（main_log_7 排在 main_log_8 前）
assert [e["path"] for e in mod.match_entries(ENTRIES, "main_log")] == [B, A]

# 目录条目不可下载，必须排除（否则会被当成文件去拉）
assert [e["path"] for e in mod.match_entries(ENTRIES, "mobilelog/")] == [B, A]

# 精确相等优先于子串：片段既等于某条完整路径，又是另一条的子串时只取精确那条
dup = [entry("a/b.gz"), entry("x/a/b.gz")]
assert [e["path"] for e in mod.match_entries(dup, "a/b.gz")] == ["a/b.gz"]

# 前导斜杠容错（zip 内路径本身不带前导 /）
assert [e["path"] for e in mod.match_entries(ENTRIES, "/CLIENT_VER")] == ["CLIENT_VER"]

# 零命中返回空列表，不得回退成「匹配全部」
assert mod.match_entries(ENTRIES, "no-such-thing") == []

# ---- 零命中退让：含 / 去掉末段；不含 / 从右逐字符截短到长度 3 ----
assert list(mod.relax_fragments("a/b/c.gz")) == ["a/b/"]
assert list(mod.relax_fragments("170217")) == ["17021", "1702", "170"]
assert list(mod.relax_fragments("170")) == []  # 已到长度下限，不再退让
assert list(mod.relax_fragments("/a/b/")) == ["a/"]  # 首尾斜杠先剥掉再判断

# 时间戳末位抄错 170217 → 退到 17021 命中真实文件
relaxed, hints, count = mod.hint_entries(ENTRIES, "170217")
assert (relaxed, [e["path"] for e in hints], count) == ("17021", [A], 1)

# 完全无从下手时给空提示，而不是把整个 zip 倒出来
assert mod.hint_entries(ENTRIES, "zzzzzz") == ("", [], 0)

# ---- 落盘路径：<输出目录>/<zip名去后缀>/<zip内相对路径>，保留层级 ----
assert mod.local_path("/tmp", "log_X.zip", "resources/a/b.gz") == "/tmp/log_X/resources/a/b.gz"
assert mod.local_path("/tmp", "log_X", "a.gz") == "/tmp/log_X/a.gz"  # 无 .zip 后缀
assert mod.local_path("/tmp", "X.ZIP", "a") == "/tmp/X/a"  # 后缀大小写
assert mod.local_path("/tmp", "x.zip", "/a/b.gz") == "/tmp/x/a/b.gz"  # 前导斜杠不产生空段

# ---- 跳过判定：大小相符才算完成，不符必须重下 ----
with tempfile.TemporaryDirectory() as d:
    f = pathlib.Path(d, "f.bin")
    f.write_bytes(b"abc")
    assert mod.is_complete(str(f), 3)
    assert not mod.is_complete(str(f), 4), "大小不符不得跳过（半截文件会被永久固化）"
    assert not mod.is_complete(str(pathlib.Path(d, "missing")), 0)
    assert not mod.is_complete(d, 0), "目录不是完成的文件"


# ---- 浏览树（##[tree 树帧）：human_size 与 Go formatFileSize 同风格 ----
assert mod.human_size(356) == "356 B"
assert mod.human_size(1456312) == "1.4 MB"

# build_entry_tree：目录链按需补建、file 带 detail/path、按 path 字典序插入
# 大写 CLIENT_VER 排在 resources 前；APLog_A 中间目录被文件条目补建
tree = mod.build_entry_tree("z.zip", ENTRIES)
assert tree["label"] == "z.zip" and tree["kind"] == "dir"
assert tree["children"][0]["label"] == "CLIENT_VER"
aplog = tree["children"][1]["children"][0]["children"][0]["children"][0]
assert aplog["label"] == "APLog_A" and aplog["kind"] == "dir"
assert [(c["label"], c["kind"], c["detail"], c["path"]) for c in aplog["children"]] == [
    ("main_log_7__2026_0905_160000.gz", "file", "100 B", B),
    ("main_log_8__2026_0905_170216.gz", "file", "6.5 MB", A),
]

# entry_tree_frame：title 读数；条目被 MAX_ENTRIES 截断时警告进 title
frame = mod.entry_tree_frame("z.zip", ENTRIES, len(ENTRIES))
assert frame["title"] == "z.zip · 共 4 个条目" and len(frame["nodes"]) == 1
trunc = mod.entry_tree_frame("z.zip", ENTRIES[:2], len(ENTRIES))
assert "仅列出前 2 个" in trunc["title"]

print("ok")
