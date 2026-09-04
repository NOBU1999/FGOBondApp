"""SQLite 数据层：建表、写入、基础查询（Task 1）。

设计说明
--------
- 严格保留任务书中的 servants / servant_stage_traits / crafts / user_box / user_teams。
- crafts 在任务书基础上增加 support_bonus、trigger_traits_json、is_bond_ce 等字段，
  用于准确表示“午茶助战值/多重特性条件/是否牵绊加成礼装”。
- 所有用户数据均存 db/fgo_data.db，不写注册表/AppData。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .constants import DB_PATH, SCHEMA_VERSION, STAGES

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
DDL = """
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servants (
    id INTEGER PRIMARY KEY,
    collection_no INTEGER NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT,
    class TEXT NOT NULL,
    cost INTEGER NOT NULL,
    rarity INTEGER,
    atk_max INTEGER,
    hp_max INTEGER,
    type TEXT
);

CREATE TABLE IF NOT EXISTS servant_stage_traits (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    stage TEXT NOT NULL CHECK(stage IN ('initial','first','second','third','fourth')),
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, stage, trait)
);
CREATE INDEX IF NOT EXISTS idx_stage_traits_stage_trait
    ON servant_stage_traits(stage, trait);

CREATE TABLE IF NOT EXISTS servant_costume_traits (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    costume_id INTEGER NOT NULL,
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, costume_id, trait)
);
CREATE INDEX IF NOT EXISTS idx_costume_traits_costume
    ON servant_costume_traits(costume_id, trait);

CREATE TABLE IF NOT EXISTS servant_costumes (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    costume_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (servant_id, costume_id)
);

CREATE TABLE IF NOT EXISTS crafts (
    id INTEGER PRIMARY KEY,
    collection_no INTEGER,
    name TEXT NOT NULL,
    original_name TEXT,
    cost INTEGER NOT NULL,
    rarity INTEGER,
    -- universal: 无条件全队加成; trait: 需要满足特性; support_only: 仅助战位生效
    bonus_type TEXT,
    -- 数值统一存小数，例如 10% -> 0.10
    bonus_value REAL,
    support_bonus REAL,
    -- JSON: [[traitName, ...], ...]，每组为 AND 条件；组间关系在计算阶段决定
    trigger_traits_json TEXT,
    detail TEXT,
    is_bond_ce INTEGER NOT NULL DEFAULT 0,
    is_event_limited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_box (
    servant_id INTEGER PRIMARY KEY,
    stage TEXT DEFAULT 'fourth',
    is_max_bond INTEGER DEFAULT 0,
    bond_switch1 INTEGER DEFAULT 1,
    bond_switch2 INTEGER DEFAULT 0,
    personal_bonus REAL DEFAULT 0,
    aura_bonus REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    fixed_servants TEXT,
    fixed_crafts TEXT,
    support_id INTEGER,
    support_craft_id INTEGER,
    cost_limit INTEGER DEFAULT 114,
    strategy TEXT DEFAULT 'total_max',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(db_path: Optional[Path | str] = None) -> sqlite3.Connection:
    """打开 SQLite 连接，自动创建父目录。"""
    path = Path(db_path or DB_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection, schema_version: int = SCHEMA_VERSION) -> None:
    """建表并写入 schema 版本。"""
    conn.executescript(DDL)
    # 轻量迁移：给已存在库补充新列
    try:
        conn.execute(
            "ALTER TABLE crafts ADD COLUMN is_event_limited INTEGER NOT NULL DEFAULT 0"
        )
    except sqlite3.OperationalError:
        pass  # 列已存在
    try:
        conn.execute(
            "ALTER TABLE user_box ADD COLUMN aura_bonus REAL DEFAULT 0"
        )
    except sqlite3.OperationalError:
        pass  # 列已存在
    conn.execute(
        "INSERT OR REPLACE INTO app_meta(key, value) VALUES(?, ?)",
        ("schema_version", str(schema_version)),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# 写入助手
# ---------------------------------------------------------------------------
def clear_data_tables(conn: sqlite3.Connection) -> None:
    """清空数据表（保留用户表与 meta），用于全量重建。"""
    conn.execute("DELETE FROM servant_costumes")
    conn.execute("DELETE FROM servant_costume_traits")
    conn.execute("DELETE FROM servant_stage_traits")
    conn.execute("DELETE FROM servants")
    conn.execute("DELETE FROM crafts")
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute(
        "SELECT value FROM app_meta WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO app_meta(key, value) VALUES(?, ?)",
        (key, value),
    )


def upsert_servant(
    conn: sqlite3.Connection,
    servant: Dict[str, Any],
) -> None:
    conn.execute(
        """
        INSERT INTO servants
            (id, collection_no, name, original_name, class, cost,
             rarity, atk_max, hp_max, type)
        VALUES (:id, :collection_no, :name, :original_name, :class, :cost,
                :rarity, :atk_max, :hp_max, :type)
        ON CONFLICT(id) DO UPDATE SET
            collection_no=excluded.collection_no,
            name=excluded.name,
            original_name=excluded.original_name,
            class=excluded.class,
            cost=excluded.cost,
            rarity=excluded.rarity,
            atk_max=excluded.atk_max,
            hp_max=excluded.hp_max,
            type=excluded.type
        """,
        servant,
    )


def upsert_stage_traits(
    conn: sqlite3.Connection,
    servant_id: int,
    stage: str,
    traits: Iterable[Tuple[str, Optional[int]]],
) -> None:
    """写入某从者某阶段的完整特性集合（先删后插）。"""
    stage = stage.lower()
    if stage not in STAGES:
        raise ValueError(f"unknown stage: {stage}")
    conn.execute(
        "DELETE FROM servant_stage_traits WHERE servant_id=? AND stage=?",
        (servant_id, stage),
    )
    conn.executemany(
        """
        INSERT OR IGNORE INTO servant_stage_traits(servant_id, stage, trait, trait_id)
        VALUES (?, ?, ?, ?)
        """,
        [(servant_id, stage, trait_name, trait_id) for trait_name, trait_id in traits],
    )


def upsert_costume_traits(
    conn: sqlite3.Connection,
    servant_id: int,
    costume_id: int,
    traits: Iterable[Tuple[str, Optional[int]]],
) -> None:
    """写入某从者某个灵衣/皮肤状态的完整特性集合（先删后插）。"""
    conn.execute(
        "DELETE FROM servant_costume_traits WHERE servant_id=? AND costume_id=?",
        (servant_id, costume_id),
    )
    conn.executemany(
        """
        INSERT OR IGNORE INTO servant_costume_traits(servant_id, costume_id, trait, trait_id)
        VALUES (?, ?, ?, ?)
        """,
        [
            (servant_id, costume_id, trait_name, trait_id)
            for trait_name, trait_id in traits
        ],
    )


def upsert_costume_name(
    conn: sqlite3.Connection,
    servant_id: int,
    costume_id: int,
    name: str,
) -> None:
    """写入灵衣中文名（数据更新时调用）。"""
    conn.execute(
        """
        INSERT INTO servant_costumes(servant_id, costume_id, name)
        VALUES (?, ?, ?)
        ON CONFLICT(servant_id, costume_id) DO UPDATE SET name=excluded.name
        """,
        (servant_id, costume_id, name or ""),
    )


def query_costume_names(
    conn: sqlite3.Connection,
) -> Dict[str, str]:
    """返回 costume_id(str) -> name，供 UI 读取。"""
    rows = conn.execute(
        "SELECT costume_id, name FROM servant_costumes WHERE name <> ''"
    ).fetchall()
    return {str(r["costume_id"]): r["name"] for r in rows}


def upsert_craft(conn: sqlite3.Connection, craft: Dict[str, Any]) -> None:
    """写入一张礼装/装备。bond CE 字段从 API skill 解析后传入。"""
    conn.execute(
        """
        INSERT INTO crafts
            (id, collection_no, name, original_name, cost, rarity,
             bonus_type, bonus_value, support_bonus, trigger_traits_json,
             detail, is_bond_ce, is_event_limited)
        VALUES
            (:id, :collection_no, :name, :original_name, :cost, :rarity,
             :bonus_type, :bonus_value, :support_bonus, :trigger_traits_json,
             :detail, :is_bond_ce, :is_event_limited)
        ON CONFLICT(id) DO UPDATE SET
            collection_no=excluded.collection_no,
            name=excluded.name,
            original_name=excluded.original_name,
            cost=excluded.cost,
            rarity=excluded.rarity,
            bonus_type=excluded.bonus_type,
            bonus_value=excluded.bonus_value,
            support_bonus=excluded.support_bonus,
            trigger_traits_json=excluded.trigger_traits_json,
            detail=excluded.detail,
            is_bond_ce=excluded.is_bond_ce,
            is_event_limited=excluded.is_event_limited
        """,
        craft,
    )


# ---------------------------------------------------------------------------
# 基础查询
# ---------------------------------------------------------------------------
def query_servants(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM servants ORDER BY collection_no"
    ).fetchall()
    return [dict(r) for r in rows]


def query_stage_traits(
    conn: sqlite3.Connection, servant_id: int, stage: Optional[str] = None
) -> List[Dict[str, Any]]:
    sql = "SELECT servant_id, stage, trait, trait_id FROM servant_stage_traits WHERE servant_id=?"
    params: Sequence[Any] = [servant_id]
    if stage:
        sql += " AND stage=?"
        params.append(stage)
    sql += " ORDER BY stage, trait"
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def query_crafts(conn: sqlite3.Connection, bond_only: bool = True) -> List[Dict[str, Any]]:
    sql = "SELECT * FROM crafts"
    params: List[Any] = []
    if bond_only:
        sql += " WHERE is_bond_ce = 1"
    sql += " ORDER BY collection_no"
    rows = conn.execute(sql, params).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        if d.get("trigger_traits_json"):
            d["trigger_traits"] = json.loads(d["trigger_traits_json"])
        else:
            d["trigger_traits"] = []
        # 用户可见分类只保留两类：牵绊礼装 / 其他礼装
        d["craft_type"] = "bond" if d.get("is_bond_ce") else "other"
        result.append(d)
    return result
