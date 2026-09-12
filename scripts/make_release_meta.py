#!/usr/bin/env python3
"""生成发布包所需的元数据，并投放更新器。

发布包根目录需要两个文件：
    version.json   记录「已安装的版本」（程序自己读；更新器用它判断当前版本）
    update.json    安装包标记（更新器用它判断包内版本与兼容区间）

做法：打包完成后（release/MyFGOApp 已就绪）执行本脚本，
再把整个 MyFGOApp 文件夹压缩成 zip / 7z 发布。

用法：
    python scripts/make_release_meta.py
    python scripts/make_release_meta.py --version 0.1.10 --compatible-from 0.1.9 \\
        --notes "多账号 + 独立更新器"
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
APP_ID = "fgo-bond-recommender"
DB_SCHEMA = 2  # v0.1.10 起：user_box/user_exclusions 带 account_id

DEFAULT_APP_DIR = PROJECT_ROOT / "release" / "MyFGOApp"
DEFAULT_UPDATER = PROJECT_ROOT / "updater" / "dist" / "updater.exe"
SEVENZIP_LICENSE = Path(r"C:\Program Files\7-Zip\License.txt")


def read_package_version() -> str:
    try:
        data = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        return str(data.get("version") or "")
    except (OSError, ValueError):
        return ""


def detect_exe(app_dir: Path) -> str:
    candidates = [
        p for p in app_dir.glob("*.exe") if p.name.lower() != "updater.exe"
    ]
    if not candidates:
        raise SystemExit(f"[FAIL] 程序目录里找不到主程序 exe：{app_dir}")
    candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
    return candidates[0].name


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[write] {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="生成发布包元数据（version.json / update.json）")
    parser.add_argument("--app-dir", type=Path, default=DEFAULT_APP_DIR,
                        help=f"便携发布目录（默认 {DEFAULT_APP_DIR}）")
    parser.add_argument("--updater", type=Path, default=DEFAULT_UPDATER,
                        help=f"更新器 exe 路径（默认 {DEFAULT_UPDATER}）")
    parser.add_argument("--version", default="", help="版本号（默认读 package.json）")
    parser.add_argument("--compatible-from", default="0.1.9",
                        help="支持基于该版本及以上安装（兼容区间下限）")
    parser.add_argument("--compatible-to", default="",
                        help="兼容区间上限（留空 = 无上限）")
    parser.add_argument("--notes", default="", help="更新说明（短）")
    parser.add_argument(
        "--stage",
        default="beta",
        help="阶段标记：beta=测试阶段（更新器会提示先备份）；传空字符串表示正式版",
    )
    parser.add_argument("--no-updater", action="store_true", help="不投放 updater.exe")
    args = parser.parse_args()

    app_dir = args.app_dir.expanduser().resolve()
    if not app_dir.exists():
        raise SystemExit(f"[FAIL] 便携目录不存在：{app_dir}")

    version = (args.version or read_package_version()).strip()
    if not version:
        raise SystemExit("[FAIL] 无法确定版本号（package.json 里没有 version）")

    built_at = datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds")
    exe_name = detect_exe(app_dir)

    # ---- 程序文件布局检查 ----
    problems = []
    if not (app_dir / "resources" / "app.asar").exists():
        problems.append("缺少 resources/app.asar（asar 还没打包？）")
    if (app_dir / "db" / "fgo_data.db").exists():
        problems.append("db/fgo_data.db 仍在发布目录（个人数据，必须先跑 scripts/privacy_clean.py）")
    if not (app_dir / "db" / "fgo_data.seed.db").exists():
        problems.append("缺少 db/fgo_data.seed.db（静态数据种子库）")
    for item in problems:
        print(f"[warn] {item}")

    # ---- 更新器 ----
    if not args.no_updater:
        updater = args.updater.expanduser().resolve()
        if not updater.exists():
            print(f"[warn] 没有找到更新器 {updater}（先跑 updater/build_updater.ps1）")
        else:
            target = app_dir / "updater.exe"
            shutil.copy2(updater, target)
            print(f"[copy] {target}（{target.stat().st_size / 1024 / 1024:.1f} MB）")
        if SEVENZIP_LICENSE.exists():
            notice = app_dir / "NOTICE-7zip.txt"
            shutil.copy2(SEVENZIP_LICENSE, notice)
            print(f"[copy] {notice}（7-Zip LGPL 许可说明）")

    # ---- 元数据 ----
    write_json(
        app_dir / "version.json",
        {
            "appId": APP_ID,
            "version": version,
            "exe": exe_name,
            "dbSchema": DB_SCHEMA,
            "stage": args.stage or "",
            "builtAt": built_at,
        },
    )
    write_json(
        app_dir / "update.json",
        {
            "appId": APP_ID,
            "version": version,
            "compatibleFrom": args.compatible_from or None,
            "compatibleTo": args.compatible_to or None,
            "dbSchema": DB_SCHEMA,
            "stage": args.stage or "",
            "builtAt": built_at,
            "notes": args.notes,
        },
    )

    print()
    print("=== 下一步 ===")
    print("1. python scripts/privacy_clean.py --check        # 确认发布目录干净")
    print(f"2. 压缩 release\\MyFGOApp 为 FGO牵绊推荐器-v{version}.zip / .7z")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
