#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把开发区的改动同步到 release/MyFGOApp（用户直接测试用的那个目录）。

用途
----
用户测试打包版时不想每次都重出包。这个脚本把「外面能改的部分」同步过去：

  ✅ python-engine/engine.exe        引擎（PyInstaller 冻结版）
  ✅ db/fgo_data.seed.db             种子库（新装/首次运行用）
  ✅ db/event_bond_bonus.json        活动牵绊表
  ✅ resources/app.asar              界面 / 主进程（直接改写归档，不用重出包）
  ✅ 使用说明.txt / RELEASE_NOTES / 动态文案（有就同步）

  ❌ db/fgo_data.db                  用户的运行库，**绝不覆盖**（装的是他自己的账号 / Box / 队伍）

用法
----
  python scripts/sync_to_test_dir.py            # 全量同步（asar 也一起）
  python scripts/sync_to_test_dir.py --check    # 只报告会改什么，不落盘
  python scripts/sync_to_test_dir.py --no-asar  # 跳过 app.asar（只同步引擎 / 数据）

注意
----
- 同步完要**重启应用**（asar 与引擎都是启动时读取）。
- 用户运行库里的静态数据由出包版 `main/runtime-db.js` 在启动时按 `static_revision` 自动刷新，
  所以不必手工动 `fgo_data.db`。
- `app.asar` 是"解包 → 换文件 → 重打包"，先把原文件备份成 `app.asar.bak-<时间戳>`。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import sys
import time
from pathlib import Path
from typing import Optional

# Windows 控制台默认 GBK，输出中文/符号会直接抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
TEST_DIR = ROOT / "release" / "MyFGOApp"
ASAR_NAME = "app.asar"

# asar 归档里需要跟随开发区更新的文件（相对 app 根目录）
ASAR_SYNC_FILES = [
    "renderer/app.js",
    "renderer/style.css",
    "renderer/index.html",
    "preload.js",
    "main/index.js",
    "main/ipc-handlers.js",
    "main/python-process.js",
    "main/runtime-db.js",
    "main/database.js",
    "main/db-reset.js",
    "main/avatars.js",
    "main/diag-log.js",
    "shared/bridge/data-bridge.mjs",
    "shared/domain/meta.mjs",
    "shared/domain/accounts.mjs",
    "shared/domain/box.mjs",
    "shared/domain/teams.mjs",
    "shared/domain/exclusions.mjs",
    "shared/domain/custom-crafts.mjs",
    "shared/domain/static-data.mjs",
    "shared/domain/index.mjs",
]

# 直接放在 MyFGOApp 下的文件（不进 asar）
PLAIN_FILES = [
    ("python-engine/engine.exe", "python-engine/engine.exe"),
    ("db/fgo_data.seed.db", "db/fgo_data.seed.db"),
    ("db/event_bond_bonus.json", "db/event_bond_bonus.json"),
    ("使用说明.txt", "使用说明.txt"),
]

def _latest_release_notes() -> list:
    """取当前版本的发布说明与动态文案（release/ 已按版本归档到 05-发布包/vX/）。"""
    pkg = ROOT / "package.json"
    version = ""
    try:
        version = str(json.loads(pkg.read_text(encoding="utf-8")).get("version") or "")
    except Exception:
        pass
    candidates = []
    if version:
        candidates.append(ROOT / "release" / "05-发布包" / f"v{version}")
    candidates.append(ROOT / "release")
    pairs = []
    for folder in candidates:
        if not folder.is_dir():
            continue
        notes = sorted(folder.glob("RELEASE_NOTES_v*.md"))
        dynamic = sorted(folder.glob("动态文案-v*.txt"))
        if notes:
            p = notes[-1]
            pairs.append((p.relative_to(ROOT) if p.is_relative_to(ROOT) else p, p.name))
        if dynamic:
            p = dynamic[-1]
            pairs.append((p.relative_to(ROOT) if p.is_relative_to(ROOT) else p, p.name))
        if pairs:
            break
    return pairs


# 仅供参考、不影响运行的说明文件（按当前版本自动定位，归档后仍然找得到）
HINT_FILES = _latest_release_notes()

# ---------------------------------------------------------------- asar 读写
# 格式参考 @electron/asar：12 字节头 + 4 字节 JSON 长度 + JSON 头 + 文件数据区。
# **打包优先用官方 CLI**（node_modules/@electron/asar），自己手写只作为兜底 ——
# 手写版本在"往返读回"验证里失败过，不要拿用户的应用去赌。


def _asar_cli() -> Optional[str]:
    cli = ROOT / "node_modules" / "@electron" / "asar" / "bin" / "asar.js"
    return str(cli) if cli.exists() else None


def _read_asar(path: Path):
    with path.open("rb") as f:
        raw = f.read()
    if len(raw) < 16:
        raise ValueError("asar 文件太小，格式不对")
    header_size = struct.unpack("<I", raw[12:16])[0]
    header = json.loads(raw[16:16 + header_size].decode("utf-8"))
    data_start = 16 + header_size
    # 头部会补齐到 4 字节边界
    return header, raw, data_start


def asar_extract(path: Path, dest: Path) -> None:
    """解包用官方 CLI（保真）；没有 CLI 时退回手写解析。"""
    cli = _asar_cli()
    if cli:
        import subprocess

        r = subprocess.run([_node_bin(), cli, "extract", str(path), str(dest)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if r.returncode != 0:
            raise RuntimeError(f"asar extract 失败：{(r.stderr or r.stdout or '')[:300]}")
        return
    _asar_extract_manual(path, dest)


def asar_pack(src: Path, dest: Path) -> None:
    """重打包用官方 CLI（保真）。"""
    import subprocess

    cli = _asar_cli()
    if not cli:
        raise RuntimeError("找不到 node_modules/@electron/asar，无法安全重打包 app.asar")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    r = subprocess.run([_node_bin(), cli, "pack", str(src), str(dest)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or not dest.exists():
        raise RuntimeError(f"asar pack 失败：{(r.stderr or r.stdout or '')[:300]}")


def _node_bin() -> str:
    for name in ("node.exe", "node"):
        found = shutil.which(name)
        if found:
            return found
    return "node"


def _asar_extract_manual(path: Path, dest: Path) -> None:
    """兜底解包（官方 CLI 不存在时用）。注意：打包**没有**兜底实现，必须用官方 CLI。"""
    header, raw, data_start = _read_asar(path)

    def safe_join(prefix: str, name: str) -> Path:
        """asar 头部里的名字可能带前导 / 或反斜杠 —— 必须净化，否则会被当成绝对路径写到盘上。"""
        clean_name = str(name).replace("\\", "/").lstrip("/")
        parts = [p for p in clean_name.split("/") if p and p not in (".", "..")]
        return dest.joinpath(*parts) if prefix == "" else dest.joinpath(prefix, *parts)

    def walk(node: dict, prefix: str) -> None:
        for name, entry in (node.get("files") or {}).items():
            full = safe_join(prefix, name)
            if "files" in entry:
                full.mkdir(parents=True, exist_ok=True)
                rel = str(full.relative_to(dest)).replace("\\", "/")
                walk(entry, rel)
            else:
                full.parent.mkdir(parents=True, exist_ok=True)
                offset = int(entry.get("offset", 0))
                size = int(entry.get("size", 0))
                full.write_bytes(raw[data_start + offset:data_start + offset + size])

    walk(header, "")


# ---------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser(description="同步开发区改动到 release/MyFGOApp")
    ap.add_argument("--check", action="store_true", help="只报告，不写文件")
    ap.add_argument("--no-asar", action="store_true", help="跳过 app.asar")
    args = ap.parse_args()

    if not TEST_DIR.exists():
        print(f"[x] 找不到测试目录：{TEST_DIR}")
        print("    （出一次包（Windows）之后才会有）")
        return 1

    changes: list[str] = []
    skipped: list[str] = []

    # ---- 1) 直接覆盖的文件 ----
    for rel_src, rel_dst in PLAIN_FILES:
        src = ROOT / rel_src
        dst = TEST_DIR / rel_dst
        if not src.exists():
            skipped.append(f"{rel_dst}（开发区没有 {rel_src}）")
            continue
        same = dst.exists() and src.stat().st_size == dst.stat().st_size and \
            src.read_bytes() == dst.read_bytes()
        if same:
            skipped.append(f"{rel_dst}（内容一致）")
            continue
        changes.append(f"{rel_dst}  ←  {rel_src}  ({src.stat().st_size / 1024 / 1024:.1f} MB)")
        if not args.check:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    for rel_src, rel_dst in HINT_FILES:
        src = ROOT / rel_src
        dst = TEST_DIR / rel_dst
        if not src.exists():
            continue
        if dst.exists() and src.read_bytes() == dst.read_bytes():
            continue
        changes.append(f"{rel_dst}（说明文件）")
        if not args.check:
            shutil.copy2(src, dst)

    # ---- 2) app.asar 里的界面 / 主进程 ----
    asar = TEST_DIR / "resources" / ASAR_NAME
    if args.no_asar:
        skipped.append("app.asar（--no-asar 已跳过）")
    elif not asar.exists():
        skipped.append("app.asar（不存在）")
    else:
        work = ROOT.parent / ".temp" / "asar-sync"
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        try:
            asar_extract(asar, work)
        except Exception as exc:  # noqa: BLE001
            print(f"[x] 解包 app.asar 失败：{exc}")
            return 2
        touched = []
        for rel in ASAR_SYNC_FILES:
            src = ROOT / rel
            dst = work / rel
            if not src.exists():
                continue
            if not dst.exists():
                print(f"    [warn] asar 里没有 {rel}（跳过）")
                continue
            if src.read_bytes() == dst.read_bytes():
                continue
            touched.append(rel)
            if not args.check:
                dst.write_bytes(src.read_bytes())
        if touched:
            changes.append(f"app.asar 内 {len(touched)} 个文件：{', '.join(touched)}")
            if not args.check:
                backup = asar.with_name(f"{ASAR_NAME}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
                shutil.copy2(asar, backup)
                tmp = asar.with_suffix(".new")
                asar_pack(work, tmp)
                os.replace(tmp, asar)
                changes.append(f"app.asar 已重打包（备份 {backup.name}）")
        else:
            skipped.append("app.asar（内容一致）")

    # ---- 3) 报告 ----
    print("=" * 60)
    if changes:
        print("已同步：" if not args.check else "将会同步（--check）：")
        for c in changes:
            print("  ·", c)
    else:
        print("没有需要同步的内容。")
    if skipped:
        print("跳过：")
        for s in skipped:
            print("  -", s)
    print("=" * 60)
    print("⚠️  你的运行库 db/fgo_data.db 没被动过（账号 / Box / 队伍都在）。")
    print("⚠️  同步完请**重启应用**；启动时它会按 static_revision 自动刷新静态数据，")
    print("    简中服的「未实装从者」名单也会一起生效。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
