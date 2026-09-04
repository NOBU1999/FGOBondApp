#!/usr/bin/env python3
"""按需获取缺失的“第一再临头像”。

规则：
- 以便携版数据库 `release/MyFGOApp/db/fgo_data.db` 的 servants.id 为准；
- 头像文件应存在于 `renderer/assets/servantface/{id}.png`
  和 `release/app-staging/renderer/assets/servantface/{id}.png`；
- 只下载缺失的 id，URL 为 Atlas CN Faces 第一再临：
  https://static.atlasacademy.io/CN/Faces/f_{id}0.png
- 若更新了 staging 头像，自动重新打包 app.asar。

用法：
    python scripts/fetch_missing_avatars.py
    python scripts/fetch_missing_avatars.py --db D:/path/fgo_data.db
"""

from __future__ import annotations

import argparse
import io
import json
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Iterable, List, Set

ROOT = Path(__file__).resolve().parents[1]
FACE_URL = "https://static.atlasacademy.io/{region}/Faces/f_{id}0.png"
UA = "FGOBondApp/0.1"


def _utf8_print(msg: str) -> None:
    try:
        print(msg)
    except Exception:
        sys.stdout.buffer.write((msg + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()


def list_servant_ids(db_path: Path) -> List[int]:
    conn = sqlite3.connect(str(db_path))
    try:
        rows = conn.execute("SELECT id FROM servants").fetchall()
        return sorted(int(r[0]) for r in rows)
    finally:
        conn.close()


def existing_ids(assets_dir: Path) -> Set[int]:
    if not assets_dir.is_dir():
        return set()
    result: Set[int] = set()
    for p in assets_dir.glob("*.png"):
        try:
            result.add(int(p.stem))
        except ValueError:
            pass
    return result


def download_face(servant_id: int, region: str) -> bytes:
    url = FACE_URL.format(region=region, id=servant_id)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    if not data.startswith(b"\x89PNG"):
        raise ValueError(f"{url} 返回的不是 PNG")
    return data


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".png.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def ensure_asar_packed(staging_dir: Path, asar_path: Path) -> None:
    asar_js = ROOT / "node_modules" / "@electron" / "asar" / "bin" / "asar.js"
    if not asar_js.exists():
        _utf8_print("[skip] 未找到 asar.js，跳过重新打包（staging 已更新）")
        return
    new_asar = asar_path.with_name("app.asar.new")
    cmd = [
        sys.executable if False else "node",
        str(asar_js),
        "pack",
        str(staging_dir),
        str(new_asar),
    ]
    _utf8_print("[pack] 正在重新打包 app.asar ...")
    subprocess.check_call(cmd, cwd=str(ROOT))
    # Windows 下若目标被占用，先尝试 Copy-Item 覆盖；asartool 输出可直接替换
    new_asar.replace(asar_path)
    _utf8_print("[pack] app.asar 已更新")


def main() -> int:
    parser = argparse.ArgumentParser(description="下载缺失的第一再临头像")
    parser.add_argument(
        "--db",
        type=Path,
        default=ROOT / "release" / "MyFGOApp" / "db" / "fgo_data.db",
        help="数据库路径（默认便携版数据库）",
    )
    parser.add_argument(
        "--region",
        default="JP",
        help="头像 CDN 区域，默认 JP（日服数据）",
    )
    args = parser.parse_args()

    db_path = args.db
    if not db_path.exists():
        _utf8_print(f"[error] 数据库不存在: {db_path}")
        return 1

    ids = list_servant_ids(db_path)
    source_dir = ROOT / "renderer" / "assets" / "servantface"
    staging_dir = ROOT / "release" / "app-staging" / "renderer" / "assets" / "servantface"
    asar_path = ROOT / "release" / "MyFGOApp" / "resources" / "app.asar"

    source_have = existing_ids(source_dir)
    staging_have = existing_ids(staging_dir)
    source_missing = sorted(set(ids) - source_have)
    staging_missing = sorted(set(ids) - staging_have)
    need_fetch = sorted(set(source_missing) | set(staging_missing))

    _utf8_print(f"[info] 从者总数: {len(ids)}")
    _utf8_print(f"[info] 源码头像: {len(source_have)}，缺失 {len(source_missing)}")
    _utf8_print(f"[info] staging头像: {len(staging_have)}，缺失 {len(staging_missing)}")

    if not need_fetch:
        _utf8_print("[info] 没有缺失头像，无需下载")
        return 0

    _utf8_print(f"[info] 需要下载 {len(need_fetch)} 个头像")
    ok = 0
    failed: List[int] = []
    for idx, sid in enumerate(need_fetch, start=1):
        try:
            data = download_face(sid, args.region)
        except Exception as exc:  # noqa: BLE001
            _utf8_print(f"[fail] {sid}: {exc}")
            failed.append(sid)
            continue
        if sid in source_missing:
            write_atomic(source_dir / f"{sid}.png", data)
        if sid in staging_missing:
            write_atomic(staging_dir / f"{sid}.png", data)
        ok += 1
        _utf8_print(f"[ok] {idx}/{len(need_fetch)} {sid}.png ({len(data)} bytes)")

    if failed:
        _utf8_print(f"[error] 失败 {len(failed)} 个: {failed}")
        return 1

    if staging_missing and staging_dir.is_dir():
        ensure_asar_packed(
            ROOT / "release" / "app-staging",
            asar_path,
        )
    _utf8_print("[done] 缺失头像已补齐")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
