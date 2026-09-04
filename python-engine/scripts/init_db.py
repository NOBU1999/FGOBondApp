#!/usr/bin/env python3
"""Task 1 数据初始化脚本。

用法示例：
    python python-engine/scripts/init_db.py
    python python-engine/scripts/init_db.py --region CN --db db/fgo_data.db --fresh
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# 允许直接 `python scripts/init_db.py` 运行
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import database, data_fetcher
from engine.constants import DEFAULT_REGION, PROJECT_ROOT


def main() -> None:
    parser = argparse.ArgumentParser(description="Build/refresh FGO SQLite database")
    parser.add_argument("--region", default=DEFAULT_REGION, help="JP/NA/CN/KR/TW")
    parser.add_argument(
        "--db",
        default=str(PROJECT_ROOT / "db" / "fgo_data.db"),
        help="SQLite database path",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="删除本地 JSON 缓存后重新从 API 下载",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="本次不读取/写入本地缓存",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="应用内更新模式：HEAD ETag，无变化则跳过重建",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="强制重建/更新（忽略 ETag）",
    )
    args = parser.parse_args()

    if args.fresh:
        cache_dir = data_fetcher.RAW_CACHE_DIR
        if cache_dir.exists():
            for p in cache_dir.glob(f"*_{data_fetcher.NICE_SERVANT_FILE}"):
                p.unlink()
            for p in cache_dir.glob(f"*_{data_fetcher.NICE_EQUIP_FILE}"):
                p.unlink()
            print(f"[init_db] removed raw cache files under {cache_dir}")

    if args.update:
        stats = data_fetcher.update_database(
            region=args.region,
            db_path=args.db,
            force=args.force,
            use_cache=not args.no_cache,
        )
    else:
        stats = data_fetcher.build_database(
            region=args.region,
            db_path=args.db,
            use_cache=not args.no_cache,
        )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"[init_db] database ready: {Path(args.db).resolve()}")


if __name__ == "__main__":
    main()
