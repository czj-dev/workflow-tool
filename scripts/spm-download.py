#!/usr/bin/env python3
"""SPM 数据平台：下载 zip 内指定文件（无认证直连）

用法:
    python3 spm-download.py <zip文件名> <zip内完整路径> [输出目录]   # 输出目录默认当前目录

示例:
    python3 spm-download.py log_1787193057533_LS6ANE0P7TK525767.zip \
        resources/debug/mobilelog/.../main_log_1__2026_0820_091720.gz /tmp/logs
"""
import json
import os
import sys
import urllib.request
import urllib.error
from collections.abc import Mapping

BASE = "https://spm.auto-pai.com/spm-data"
ZIP_PREFIX = "autopai-tlc/platform/C5181/log/"
CHUNK_SIZE = 2 * 1024 * 1024  # 服务端分块上限


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
        sys.exit(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")


def resolve_args(argv: list[str], env: Mapping[str, str]) -> list[str]:
    """解析实参，返回 [zip名, zip内路径] 或 [zip名, zip内路径, 输出目录]；不修改入参。

    script 形态直挂时无薄壳传参，参数从环境变量读（action params 会注入子进程 env）。
    """
    if len(argv) in (3, 4):
        return list(argv[1:])
    if len(argv) == 1 and env.get("ZIP_NAME") and env.get("INNER_PATH"):
        args = [env["ZIP_NAME"], env["INNER_PATH"]]
        out_dir = env.get("OUT_DIR", "")
        if out_dir:
            args.append(out_dir)
        return args
    sys.exit(__doc__)


def main() -> None:
    args = resolve_args(sys.argv, os.environ)
    zip_name, inner = args[0], args[1].lstrip("/")
    out_dir = args[2] if len(args) == 3 else os.getcwd()
    zip_path = ZIP_PREFIX + zip_name

    sid = post("/api/storage/connectWithPreset", {"user_id": "spm"})["data"]["session_id"]
    info = post(f"/api/storage/{sid}/archive/info",
                {"file_path": zip_path, "max_entries": 2000})["data"]

    target = next((e for e in info["entries"] if e["path"] == inner), None)
    if target is None:
        sys.exit(f"zip 内未找到: {inner}\nzip 共 {info['total_entries']} 个条目")
    if info.get("has_more"):
        print(f"警告: zip 超过 2000 条，目标可能不在已列条目中", file=sys.stderr)

    total = target["size"]
    print(f"目标: {target['path']} ({total} 字节，分 "
          f"{(total + CHUNK_SIZE - 1) // CHUNK_SIZE} 块)")
    buf = bytearray()
    for off in range(0, total, CHUNK_SIZE):
        n = min(CHUNK_SIZE, total - off)
        r = post(f"/api/storage/{sid}/archive/file",
                 {"archive_path": zip_path, "file_path": target["path"],
                  "content_offset": off, "content_length": n})
        buf += bytes(r["data"]["content"])
        # ##[progress ...] 由 workflow-tool 识别为进度流，原地覆盖上一行（见 docs/action.md）
        print(f"##[progress 下载 {len(buf) * 100 // total}%  "
              f"{len(buf)}/{total} 字节]", flush=True)

    out = os.path.join(out_dir, os.path.basename(target["path"]))
    os.makedirs(out_dir, exist_ok=True)
    with open(out, "wb") as f:
        f.write(bytes(buf))
    print(f"已保存 {out} ({len(buf)} 字节)")
    print(f"##[output saved_path={out}]")


if __name__ == "__main__":
    main()