"""数据查询模块（Task 1）。

提供 UI / 后续计算引擎需要的常用查询：
- 从者列表与详情
- 指定灵基阶段特性
- 牵绊加成礼装列表
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional, Set

from . import database
from .constants import DB_PATH


def _connect(db_path=None) -> sqlite3.Connection:
    return database.connect(db_path or DB_PATH)


def list_servants(db_path=None) -> List[Dict[str, Any]]:
    """返回全部可从者（按 collection_no 排序）。"""
    conn = _connect(db_path)
    try:
        return database.query_servants(conn)
    finally:
        conn.close()


def get_servant(servant_id: int, db_path=None) -> Optional[Dict[str, Any]]:
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM servants WHERE id = ?", (servant_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_stage_traits(
    servant_id: int,
    stage: str,
    db_path=None,
) -> List[Dict[str, Any]]:
    """返回某从者某阶段特性行（trait 名/ID）。"""
    conn = _connect(db_path)
    try:
        return database.query_stage_traits(conn, servant_id, stage)
    finally:
        conn.close()


def get_stage_trait_names(
    servant_id: int,
    stage: str,
    db_path=None,
) -> Set[str]:
    """返回某从者某阶段特性名集合，计算引擎/UI 最常用。"""
    return {r["trait"] for r in get_stage_traits(servant_id, stage, db_path)}


def get_all_stage_traits(servant_id: int, db_path=None) -> Dict[str, Set[str]]:
    conn = _connect(db_path)
    try:
        rows = database.query_stage_traits(conn, servant_id)
        result: Dict[str, Set[str]] = {}
        for r in rows:
            result.setdefault(r["stage"], set()).add(r["trait"])
        return result
    finally:
        conn.close()


def list_bond_crafts(db_path=None) -> List[Dict[str, Any]]:
    """返回全部牵绊加成礼装（含 trigger_traits 已反序列化）。"""
    conn = _connect(db_path)
    try:
        return database.query_crafts(conn, bond_only=True)
    finally:
        conn.close()


def list_all_crafts(db_path=None) -> List[Dict[str, Any]]:
    conn = _connect(db_path)
    try:
        return database.query_crafts(conn, bond_only=False)
    finally:
        conn.close()


def get_craft(craft_id: int, db_path=None) -> Optional[Dict[str, Any]]:
    conn = _connect(db_path)
    try:
        row = conn.execute("SELECT * FROM crafts WHERE id = ?", (craft_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["trigger_traits"] = __import__("json").loads(d.get("trigger_traits_json") or "[]")
        return d
    finally:
        conn.close()
