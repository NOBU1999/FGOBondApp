#!/usr/bin/env python3
"""Task 1 数据验证脚本：检查库内数据完整性与已知特殊从者。"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import queries
from engine.constants import PROJECT_ROOT

DB = PROJECT_ROOT / "db" / "fgo_data.db"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    servants = conn.execute("SELECT COUNT(*) c FROM servants").fetchone()["c"]
    stage_rows = conn.execute("SELECT COUNT(*) c FROM servant_stage_traits").fetchone()["c"]
    crafts = conn.execute("SELECT COUNT(*) c FROM crafts").fetchone()["c"]
    bond_ces = conn.execute("SELECT COUNT(*) c FROM crafts WHERE is_bond_ce=1").fetchone()["c"]
    print(f"servants={servants} stage_trait_rows={stage_rows} crafts={crafts} bond_ces={bond_ces}")

    print("\n-- bond CEs --")
    rows = conn.execute(
        "SELECT id, name, bonus_type, bonus_value, support_bonus, trigger_traits_json "
        "FROM crafts WHERE is_bond_ce=1 ORDER BY collection_no"
    ).fetchall()
    for r in rows:
        print(
            f"{r['id']} | {r['name']} | type={r['bonus_type']} "
            f"bonus={r['bonus_value']} support={r['support_bonus']} "
            f"triggers={r['trigger_traits_json']}"
        )

    print("\n-- special servants stage traits --")
    special_ids = [2300400, 304800, 105000, 204300, 505300, 505500, 2300500, 500400, 603700, 1101100, 703700]
    for sid in special_ids:
        sv = conn.execute("SELECT id, name FROM servants WHERE id=?", (sid,)).fetchone()
        if not sv:
            print(f"{sid}: NOT IN DB")
            continue
        print(f"\n{sv['id']} {sv['name']}")
        for stage in ("initial", "first", "second", "third", "fourth"):
            traits = conn.execute(
                "SELECT trait FROM servant_stage_traits WHERE servant_id=? AND stage=? ORDER BY trait",
                (sid, stage),
            ).fetchall()
            names = [t["trait"] for t in traits]
            # 只显示与“常见基础项”不同的关键项
            special = [
                n for n in names
                if any(k in n for k in ("child", "alignment", "knights", "Beast", "Animals", "demonic", "hominidae", "summer", "king"))
            ]
            print(f"  {stage}: {special}")

    conn.close()


if __name__ == "__main__":
    main()
