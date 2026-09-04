"""活动牵绊加成解析与 event_bond_bonus.json 生成。

数据源：
1. JP nice_servant.json 的 extraPassive（主数据源）
   - 活动限定被动技能：如 940464/940465/940466/940467
   - 通过 funcType == "servantFriendshipUp" 与 svals[].RateCount 取百分比
   - 通过 skill.extraPassive[].eventId 关联到对应 eventQuest
2. JP nice_event.json 的 campaign.target == "questFriendship"（兜底/补充）
   - targetIds 为空 -> 全队/全从者加成
   - targetIds 非空 -> 特定从者加成
   - value 示例：1200 = +20%，1300 = +30%
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from .constants import NICE_EVENT_FILE, NICE_SERVANT_FILE

BOND_TARGETS = {"questFriendship"}


def _load_translations() -> Dict[str, Dict[str, str]]:
    path = Path(__file__).resolve().parent / "data" / "name_translations.json"
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _translate_event_name(raw_name: str) -> str:
    if not raw_name:
        return raw_name or ""
    table = _load_translations().get("event_names", {})
    return table.get(raw_name) or raw_name


def _looks_japanese(value: str) -> bool:
    return bool(re.search(r"[\u3040-\u30ff\u31f0-\u31ff]", value or ""))


def _clean_event_name(q_cn: str, campaign_cn: str = "") -> str:
    """去掉活动名后面“关联从者获得牵绊点数提升xx%”之类的附加说明。"""
    if not _looks_japanese(q_cn):
        return q_cn
    m = re.search(r"[「『]([^」』]+)[」』]", campaign_cn or "")
    if m:
        return m.group(1).strip()
    # 去掉常见中文/日文加成说明尾巴
    cleaned = re.sub(
        r"(关联从者|関連サーヴァント|関連从者|獲得|获得).*$",
        "",
        campaign_cn or q_cn,
    )
    return cleaned.strip() or q_cn


def _norm_text(value: str) -> str:
    return re.sub(r"[\s\r\n「」『』・･()（）]", "", value or "").lower()


def _bracket_title(value: str) -> Optional[str]:
    m = re.search(r"[「『]([^」』]+)[」』]", value or "")
    return m.group(1).strip() if m else None


def _find_matching_event_quest(
    ev: Dict[str, Any],
    event_quests: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """把 questCampaign 的牵绊加成挂到对应 eventQuest（关卡配置活动）上。"""
    title = _bracket_title(ev.get("name") or "")
    if not title:
        return None

    title_n = _norm_text(title)
    c_start = ev.get("startedAt")
    c_end = ev.get("endedAt")

    def time_close(q: Dict[str, Any]) -> bool:
        qs = q.get("startedAt") or 0
        qe = q.get("endedAt") or 0
        # 活动前 campaign 可能与 eventQuest 首尾相邻；允许最多 20 天间隔
        gap_before = (qs - (c_end or 0)) if c_end else 0
        gap_after = (c_start or 0) - qe
        close = False
        if c_start and qs and c_end and qe:
            close = not (c_end < qs - 20 * 86400 or c_start > qe + 20 * 86400)
        return close or max(abs(gap_before), abs(gap_after)) <= 20 * 86400

    best = None
    best_score = -1
    for q in event_quests:
        qname_n = _norm_text(q.get("name") or "")
        score = 0
        if title_n and (title_n in qname_n or qname_n in title_n):
            score += 10
        if time_close(q):
            score += 1
        if score > best_score:
            best_score = score
            best = q
    # 必须名称匹配到 eventQuest（如 CBC2026 / 活动名），避免把 Lostbelt/泛用 campaign 挂错
    if best_score < 10:
        return None
    return best


def _extract_extra_passive_friendship(
    servants: List[Dict[str, Any]],
) -> Dict[int, Dict[str, Dict[float, set]]]:
    """从 nice_servant.json 的 extraPassive 中提取活动限定牵绊加成。

    返回：
        {event_id: {scope: {bonus_percent: {servant_id, ...}}}}
    scope:
        "self" - 只影响该从者自身，适合写 personalBonus
        "team" - 该从者在队时给全队的光环，适合写 auraBonus
    """
    result: Dict[int, Dict[str, Dict[float, set]]] = {}

    for servant in servants or []:
        try:
            servant_id = int(servant.get("id") or 0)
        except (TypeError, ValueError):
            continue
        if servant_id <= 0:
            continue

        for skill in servant.get("extraPassive") or []:
            for func in skill.get("functions") or []:
                if func.get("funcType") != "servantFriendshipUp":
                    continue
                rate_count = 0
                for sv in func.get("svals") or []:
                    try:
                        rate_count = max(rate_count, int(sv.get("RateCount") or 0))
                    except (TypeError, ValueError):
                        continue
                if not rate_count:
                    continue
                # RateCount 单位是 0.1%，500 = 50%
                friendship_percent = round(rate_count / 10.0, 2)
                target_type = func.get("funcTargetType") or "self"
                scope = "team" if target_type == "ptFull" else "self"

                for grant in skill.get("extraPassive") or []:
                    try:
                        event_id = int(grant.get("eventId") or 0)
                    except (TypeError, ValueError):
                        continue
                    if event_id <= 0:
                        continue
                    result.setdefault(event_id, {}).setdefault(
                        scope, {}
                    ).setdefault(friendship_percent, set()).add(servant_id)

    return result


def _add_bonus(
    bonus_map: Dict[int, Dict[str, Dict[float, set]]],
    event_id: int,
    scope: str,
    bonus_percent: float,
    servant_ids: List[int],
) -> None:
    """把一条加成记录合并进 (event_id, scope, percent) 桶。"""
    if not servant_ids:
        return
    scope_bucket = bonus_map.setdefault(event_id, {}).setdefault(scope, {})
    scope_bucket.setdefault(round(bonus_percent, 2), set()).update(
        int(x) for x in servant_ids
    )


def parse_event_bond_bonuses(
    events: List[Dict[str, Any]],
    servants: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """生成全部 eventQuest（关卡配置活动）加成表。

    每个 eventQuest 输出一条记录，按开始时间从新到旧排序；
    extraPassive（活动限定被动）优先，questFriendship campaign 作为补充。
    相同百分比会按活动合并为一份 servantIds。
    """
    events = events or []
    event_quests = [
        e for e in events
        if e.get("type") == "eventQuest" and (e.get("warIds") or [])
    ]
    quest_by_id = {int(e.get("id") or 0): e for e in event_quests}

    # event_id -> scope -> percent -> set(servant_id)
    bonus_map: Dict[int, Dict[str, Dict[float, set]]] = {}
    name_fallback: Dict[int, str] = {}

    # 来源 1：questFriendship campaign（兜底/旧数据兼容，均为单体 self）
    for ev in events:
        if ev.get("type") == "eventQuest":
            continue
        for camp in ev.get("campaigns") or []:
            target = camp.get("target")
            if target not in BOND_TARGETS:
                continue
            value = int(camp.get("value") or 0)
            if value <= 1000:
                continue
            raw_ids = camp.get("targetIds") or []
            servant_ids = sorted({int(x) for x in raw_ids if str(x).isdigit()})
            if not servant_ids:
                continue  # 无具体从者的泛用/道具类加成不导入个人加成
            bonus_percent = round((value - 1000) / 10.0, 2)

            quest = _find_matching_event_quest(ev, event_quests)
            if quest is None:
                continue

            event_id = int(quest.get("id") or 0)
            campaign_cn = _translate_event_name(ev.get("name") or "")
            if _looks_japanese(_translate_event_name(quest.get("name") or "")) and campaign_cn:
                name_fallback.setdefault(event_id, campaign_cn)
            _add_bonus(bonus_map, event_id, "self", bonus_percent, servant_ids)

    # 来源 2：nice_servant extraPassive（主数据，含 50/20/5 等分级）
    if servants:
        for event_id, by_scope in _extract_extra_passive_friendship(servants).items():
            if event_id not in quest_by_id:
                continue
            for scope, by_percent in by_scope.items():
                for bonus_percent, servant_ids in by_percent.items():
                    _add_bonus(
                        bonus_map,
                        event_id,
                        scope,
                        bonus_percent,
                        sorted(servant_ids),
                    )

    result: List[Dict[str, Any]] = []
    for q in sorted(event_quests, key=lambda e: (e.get("startedAt") or 0), reverse=True):
        qid = int(q.get("id") or 0)
        q_cn = _translate_event_name(q.get("name") or "")
        # 若 eventQuest 名仍是日文，尝试用关联 questCampaign 的中文活动名，并去掉加成说明尾巴
        event_name = _clean_event_name(q_cn, name_fallback.get(qid, ""))
        event_bucket = bonus_map.get(qid) or {}
        bonuses = []
        for scope, by_percent in event_bucket.items():
            for percent, ids in by_percent.items():
                bonuses.append({
                    "bonusPercent": percent,
                    "servantIds": sorted(ids),
                    "scope": scope,
                })
        # 展示/导入顺序：team 光环放前面，其次按百分比从高到低
        bonuses.sort(key=lambda r: (0 if r["scope"] == "team" else 1, -r["bonusPercent"]))
        result.append({
            "eventId": qid,
            "eventName": event_name,
            "startedAt": q.get("startedAt"),
            "endedAt": q.get("endedAt"),
            "bonuses": bonuses,
        })

    return result


def update_event_bond_bonus(
    region: str = "JP",
    db_path: Optional[Path | str] = None,
    use_cache: bool = True,
    progress: Optional[Any] = None,
) -> Dict[str, Any]:
    """下载/读取 JP nice_event.json + nice_servant.json，解析后写到 DB 同目录 event_bond_bonus.json。"""
    from . import data_fetcher  # noqa: PLC0415
    from .constants import DB_PATH, RAW_CACHE_DIR  # noqa: PLC0415

    if progress:
        progress("正在下载活动数据...")
    events = data_fetcher._load_json_cached(  # noqa: SLF001
        region,
        NICE_EVENT_FILE,
        RAW_CACHE_DIR,
        "nice_event",
        use_cache,
    )

    if progress:
        progress("正在读取从者活动被动技能...")
    servants = data_fetcher._load_json_cached(  # noqa: SLF001
        region,
        NICE_SERVANT_FILE,
        RAW_CACHE_DIR,
        "nice_servant",
        use_cache,
    )

    if progress:
        progress("正在解析活动牵绊加成...")
    records = parse_event_bond_bonuses(events, servants)

    db_path = Path(db_path or DB_PATH)
    out = db_path.parent / "event_bond_bonus.json"
    out.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    event_count = len({r["eventId"] for r in records})
    bonus_count = sum(len(r["bonuses"]) for r in records)
    if progress:
        progress(f"活动牵绊加成解析完成：{event_count} 个活动，{bonus_count} 条加成")
    return {
        "event_bond_events": event_count,
        "event_bond_records": bonus_count,
        "event_bond_file": str(out),
    }
