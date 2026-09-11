#!/usr/bin/env python3
"""SPM 数据平台：按片段匹配并下载 zip 内文件（无认证直连）

用法:
    python3 spm-download.py <zip文件名> [zip内路径片段] [输出目录]   # 输出目录默认当前目录

<zip内路径片段> 先按 zip 内完整路径精确匹配；不中则按大小写不敏感的子串筛，
命中多个时全部下载。示例片段：170216 / main_log_8__2026_0905_170216.gz /
resources/debuglogger/mobilelog/

片段留空 = 浏览模式：打印 zip 内全部条目的 ##[tree 树帧（workflow-tool 输出
控制台渲染为可交互树块）后退出，从树里复制文件路径回填片段重跑即可下载。

落盘位置为 <输出目录>/<zip名去后缀>/<zip内相对路径>，保留 zip 内层级以免同名文件互相覆盖。
已存在且大小与 zip 内记录一致的文件直接跳过，所以取消后重跑只补未完成的部分。

示例:
    python3 spm-download.py log_1788599460103_LS6ANE0P0TK534164.zip 170216 /tmp/logs
"""
import concurrent.futures as cf
import json
import os
import sys
import threading
import urllib.error
import urllib.request
from collections.abc import Mapping

BASE = "https://spm.auto-pai.com/spm-data"
ZIP_PREFIX = "autopai-tlc/platform/C5181/log/"
# 实测服务端并无 2MB 分块上限（16MB / 64MB 请求均正常返回），且块越大每请求的固定开销摊得越薄。
CHUNK_SIZE = 8 * 1024 * 1024
# 并发放在文件之间（单文件内部仍顺序分块），实测 4 路相对串行约 3x。
WORKERS = 4
MAX_ENTRIES = 2000
HINT_LIMIT = 20


class SpmError(Exception):
    """服务端返回非 2xx；由调用方决定是致命错误还是只跳过当前文件。"""


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        raise SpmError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from e


def resolve_args(argv: list[str], env: Mapping[str, str]) -> list[str]:
    """解析实参，返回 [zip名, zip内片段(空=浏览模式), 输出目录?]；不修改入参。

    script 形态直挂时无薄壳传参，参数从环境变量读（action params 会注入子进程 env，
    表单清空的参数以空串注入——空 INNER_PATH 即浏览模式入口）。
    """
    if len(argv) in (2, 3, 4):
        return list(argv[1:])
    if len(argv) == 1 and env.get("ZIP_NAME"):
        args = [env["ZIP_NAME"], env.get("INNER_PATH", "")]
        out_dir = env.get("OUT_DIR", "")
        if out_dir:
            args.append(out_dir)
        return args
    sys.exit(__doc__)


def match_entries(entries: list[dict], fragment: str) -> list[dict]:
    """片段 → 命中条目：完整路径精确相等优先，否则大小写不敏感子串；结果按 path 字典序。

    目录条目下载不了，一律排除。
    """
    files = [e for e in entries if not e.get("is_directory")]
    frag = fragment.lstrip("/")
    exact = [e for e in files if e["path"] == frag]
    if exact:
        return exact
    low = frag.lower()
    return sorted((e for e in files if low in e["path"].lower()), key=lambda e: e["path"])


def relax_fragments(fragment: str):
    """零命中时的退让序列：含 / 则去掉最后一段；不含 / 则从右逐字符截短到长度 3。

    纯数字片段（如时间戳 170216）抄错末几位是最常见的失误，逐字符截短正好覆盖这种情况。
    """
    frag = fragment.strip("/")
    if "/" in frag:
        yield frag.rsplit("/", 1)[0] + "/"
        return
    for n in range(len(frag) - 1, 2, -1):
        yield frag[:n]


def hint_entries(entries: list[dict], fragment: str) -> tuple[str, list[dict], int]:
    """零命中时给提示：返回首个能命中的退让片段、其命中的前若干条、命中总数。"""
    for relaxed in relax_fragments(fragment):
        found = match_entries(entries, relaxed)
        if found:
            return relaxed, found[:HINT_LIMIT], len(found)
    return "", [], 0


def zip_stem(zip_name: str) -> str:
    """zip 文件名去掉 .zip 后缀，作为落盘的一级目录名。"""
    return zip_name[:-4] if zip_name.lower().endswith(".zip") else zip_name


def local_path(out_dir: str, zip_name: str, entry_path: str) -> str:
    """<输出目录>/<zip名去后缀>/<zip内相对路径>。"""
    return os.path.join(out_dir, zip_stem(zip_name), *entry_path.lstrip("/").split("/"))


def is_complete(path: str, size: int) -> bool:
    """已存在且大小与 zip 内记录一致 → 视为下载完成，可跳过。"""
    return os.path.isfile(path) and os.path.getsize(path) == size


class Progress:
    """并发下唯一单调递增的量是累计字节，故进度按总字节比 + 已完成文件数呈现。"""

    def __init__(self, total_bytes: int, total_files: int) -> None:
        self._lock = threading.Lock()
        self._bytes = 0
        self._files = 0
        self._total_bytes = total_bytes
        self._total_files = total_files

    def add_bytes(self, n: int) -> None:
        with self._lock:
            self._bytes += n
            self._render()

    def finish_file(self) -> None:
        with self._lock:
            self._files += 1
            self._render()

    def _render(self) -> None:
        pct = self._bytes * 100 // self._total_bytes if self._total_bytes else 100
        # ##[progress ...] 由 workflow-tool 识别为进度流，原地覆盖上一行（见 docs/action.md）
        print(
            f"##[progress {self._files}/{self._total_files} 文件 · {pct}% · "
            f"{self._bytes / 1048576:.1f}/{self._total_bytes / 1048576:.1f} MB]",
            flush=True,
        )


def fetch_entry(sid: str, zip_path: str, entry: dict, dest: str, progress: Progress) -> None:
    """分块拉取单个文件；先写 .part 再原子改名，避免被杀后的半截文件被当成已完成而永久跳过。"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    total, tmp = entry["size"], dest + ".part"
    with open(tmp, "wb") as f:
        for off in range(0, total, CHUNK_SIZE):
            r = post(
                f"/api/storage/{sid}/archive/file",
                {
                    "archive_path": zip_path,
                    "file_path": entry["path"],
                    "content_offset": off,
                    "content_length": min(CHUNK_SIZE, total - off),
                },
            )
            chunk = bytes(r["data"]["content"])
            f.write(chunk)
            progress.add_bytes(len(chunk))
    os.replace(tmp, dest)


def load_entries(sid: str, zip_path: str) -> tuple[list[dict], int]:
    """拉取 zip 条目清单；返回 (entries, total_entries) 并在真截断时告警。"""
    info = post(
        f"/api/storage/{sid}/archive/info",
        {"file_path": zip_path, "max_entries": MAX_ENTRIES},
    )["data"]
    entries, total = info["entries"], info["total_entries"]
    # 服务端目前忽略 max_entries、has_more 恒为 False，数量不符才是与服务端实现无关的真截断信号。
    if total != len(entries):
        print(
            f"警告: zip 共 {total} 个条目，只列出 {len(entries)} 个，目标可能不在已列条目中",
            file=sys.stderr,
        )
    return entries, total


def no_match_message(entries: list[dict], fragment: str, total: int) -> str:
    """零命中时的错误文案：附上退让片段能命中的条目，帮用户定位抄错的那几位。"""
    relaxed, hints, count = hint_entries(entries, fragment)
    lines = [f"zip 内无匹配: {fragment}（共 {total} 个条目）"]
    if hints:
        lines.append(f"改用片段 {relaxed!r} 可命中 {count} 条，列出前 {len(hints)} 条：")
        lines += [f"  {e['path']}" for e in hints]
    return "\n".join(lines)


# ---- 浏览树（##[tree 协议行，schema 对齐 internal/adb/tree.go）-----------------

def human_size(n: int) -> str:
    """字节 → 人类可读，与 list-files 的 formatFileSize 同风格（1.4 MB / 356 B）。"""
    if n < 1024:
        return f"{n} B"
    value = float(n)
    for unit in ("KB", "MB", "GB", "TB"):
        value /= 1024
        if value < 1024 or unit == "TB":
            return f"{value:.1f} {unit}"


def build_entry_tree(zip_name: str, entries: list[dict]) -> dict:
    """条目清单 → 树帧根节点（root=zip 名；label=文件名、kind=dir/file、
    detail=大小、path=zip 内完整路径——叶子复制回填 INNER_PATH 即精确命中）。"""
    root = {"label": zip_name, "kind": "dir", "children": []}
    dir_nodes = {"": root}  # zip 内目录路径（无首尾斜杠）→ 对应节点

    def ensure_dir(dir_path: str) -> dict:
        # 条目清单未必显式含目录条目，中间目录按需补建（父先于子，递归一层即达）。
        node = dir_nodes.get(dir_path)
        if node is None:
            parent_path, _, name = dir_path.rpartition("/")
            node = {"label": name, "kind": "dir", "children": []}
            ensure_dir(parent_path)["children"].append(node)
            dir_nodes[dir_path] = node
        return node

    for e in sorted(entries, key=lambda e: e["path"]):
        entry_path = e["path"].strip("/")
        if not entry_path:
            continue
        parent_path, _, name = entry_path.rpartition("/")
        if e.get("is_directory"):
            ensure_dir(entry_path)  # 已作为中间目录建过则幂等
            continue
        ensure_dir(parent_path)["children"].append(
            {
                "label": name,
                "kind": "file",
                "detail": human_size(e.get("size", 0)),
                "path": e["path"],
            }
        )
    return root


def entry_tree_frame(zip_name: str, entries: list[dict], total: int) -> dict:
    """组装全量浏览树帧；条目被 MAX_ENTRIES 截断时警告进 title。"""
    title = f"{zip_name} · 共 {total} 个条目"
    if total > len(entries):
        title += f"，仅列出前 {len(entries)} 个（MAX_ENTRIES={MAX_ENTRIES}）"
    return {"title": title, "nodes": [build_entry_tree(zip_name, entries)]}


def emit_tree(frame: dict) -> None:
    """树帧打印为单行 ##[tree 协议行（紧凑 JSON，无换行；host 解析见 docs/action.md）。"""
    print("##[tree " + json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "]", flush=True)


def main() -> None:
    args = resolve_args(sys.argv, os.environ)
    zip_name = args[0]
    fragment = args[1] if len(args) > 1 else ""
    out_dir = args[2] if len(args) > 2 else os.getcwd()
    zip_path = ZIP_PREFIX + zip_name

    try:
        sid = post("/api/storage/connectWithPreset", {"user_id": "spm"})["data"]["session_id"]
        entries, total = load_entries(sid, zip_path)
    except SpmError as e:
        sys.exit(str(e))

    # 片段留空 = 浏览模式：只发全量树帧，不进入下载流程。
    if not fragment.strip():
        emit_tree(entry_tree_frame(zip_name, entries, total))
        return

    targets = match_entries(entries, fragment)
    if not targets:
        # 零命中：退让提示与 exit 非零照旧，追加全量树帧让用户直接选目标回填重跑。
        emit_tree(entry_tree_frame(zip_name, entries, total))
        sys.exit(no_match_message(entries, fragment, total))

    total_bytes = sum(e["size"] for e in targets)
    print(f"命中 {len(targets)} 个文件，共 {total_bytes / 1048576:.1f} MB")
    progress = Progress(total_bytes, len(targets))
    skipped, failed = 0, []

    def run_one(entry: dict) -> bool:
        """返回 True 表示跳过（已存在且大小相符）。"""
        dest = local_path(out_dir, zip_name, entry["path"])
        if is_complete(dest, entry["size"]):
            progress.add_bytes(entry["size"])
            return True
        fetch_entry(sid, zip_path, entry, dest, progress)
        return False

    with cf.ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(run_one, e): e for e in targets}
        for fut in cf.as_completed(futures):
            entry = futures[fut]
            try:
                was_skipped = fut.result()
            except Exception as e:  # 单个文件失败不连带作废其余文件
                failed.append(entry["path"])
                print(f"✗ {entry['path']}: {e}", file=sys.stderr)
                continue
            progress.finish_file()
            if was_skipped:
                skipped += 1
                print(f"↷ 跳过（已存在）{entry['path']}")
            else:
                print(f"✓ {entry['path']} ({entry['size'] / 1048576:.1f} MB)")

    saved_dir = os.path.join(out_dir, zip_stem(zip_name))
    ok = len(targets) - len(failed)
    print(f"完成: 就位 {ok} 个（其中跳过 {skipped} 个），失败 {len(failed)} 个 → {saved_dir}")
    print(f"##[output saved_dir={saved_dir}]")
    print(f"##[output saved_count={ok}]")
    print(f"##[output failed_count={len(failed)}]")
    # 命中恰好 1 个时额外发 saved_path，保住下游 workflow 引用单个文件的既有契约。
    if len(targets) == 1 and not failed:
        print(f"##[output saved_path={local_path(out_dir, zip_name, targets[0]['path'])}]")
    if failed:
        sys.exit(f"{len(failed)} 个文件下载失败")


if __name__ == "__main__":
    main()
