"""Task 2：加成计算公式与队伍评估。

该模块只做“给定完整队伍 → 计算每个成员倍率/总倍率”，不负责搜索。
搜索由 search.py 负责。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from . import database
from .constants import STAGES
from .models import FRONT_POSITIONS, POSITIONS


# ---------------------------------------------------------------------------
# 运行时数据上下文
# ---------------------------------------------------------------------------
@dataclass
class ServantInfo:
    id: int
    name: str
    servant_class: str
    cost: int
    rarity: int
    traits: Dict[str, Set[str]] = field(default_factory=dict)  # stage -> trait names


@dataclass
class CraftInfo:
    id: int
    name: str
    cost: int
    rarity: int
    bonus_type: Optional[str]
    bonus_value: float
    support_bonus: float
    trigger_traits: List[List[str]]
    is_bond_ce: bool
    detail: str = ""
    is_event_limited: bool = False


@dataclass
class DataContext:
    servants: Dict[int, ServantInfo] = field(default_factory=dict)
    crafts: Dict[int, CraftInfo] = field(default_factory=dict)

    def servant_traits(self, servant_id: int, stage: str) -> Set[str]:
        servant = self.servants.get(servant_id)
        if not servant:
            return set()
        return servant.traits.get(stage, set())


def _load_all_servants(conn: sqlite3.Connection) -> Dict[int, ServantInfo]:
    rows = conn.execute(
        "SELECT id, name, class, cost, rarity FROM servants"
    ).fetchall()
    result = {}
    for r in rows:
        result[int(r["id"])] = ServantInfo(
            id=int(r["id"]),
            name=r["name"],
            servant_class=r["class"],
            cost=int(r["cost"] or 0),
            rarity=r["rarity"],
        )
    return result


def _load_all_traits(conn: sqlite3.Connection) -> Dict[int, Dict[str, Set[str]]]:
    rows = conn.execute(
        "SELECT servant_id, stage, trait FROM servant_stage_traits"
    ).fetchall()
    result: Dict[int, Dict[str, Set[str]]] = {}
    for r in rows:
        sid = int(r["servant_id"])
        result.setdefault(sid, {}).setdefault(r["stage"], set()).add(r["trait"])

    # 灵衣状态使用独立表，加载时表示为 costume_<id>，不占用普通再临阶段键。
    costume_rows = conn.execute(
        "SELECT servant_id, costume_id, trait FROM servant_costume_traits"
    ).fetchall()
    for r in costume_rows:
        sid = int(r["servant_id"])
        key = f"costume_{int(r['costume_id'])}"
        result.setdefault(sid, {}).setdefault(key, set()).add(r["trait"])
    return result


def _load_all_crafts(conn: sqlite3.Connection) -> Dict[int, CraftInfo]:
    rows = conn.execute("SELECT * FROM crafts").fetchall()
    result = {}
    for r in rows:
        trigger = json.loads(r["trigger_traits_json"] or "[]")
        result[int(r["id"])] = CraftInfo(
            id=int(r["id"]),
            name=r["name"],
            cost=int(r["cost"] or 0),
            rarity=r["rarity"],
            bonus_type=r["bonus_type"],
            bonus_value=float(r["bonus_value"] or 0),
            support_bonus=float(r["support_bonus"] or 0),
            trigger_traits=trigger,
            is_bond_ce=bool(r["is_bond_ce"]),
            detail=r["detail"] or "",
            is_event_limited=bool(r["is_event_limited"]),
        )
    return result


def load_context(db_path: Optional[str] = None) -> DataContext:
    """从 SQLite 一次性加载计算所需数据。"""
    conn = database.connect(db_path)
    # 确保较新表（如灵衣特性表）存在，兼容旧库。
    database.init_db(conn)
    try:
        servants = _load_all_servants(conn)
        traits = _load_all_traits(conn)
        for sid, info in servants.items():
            info.traits = traits.get(sid, {})
        crafts = _load_all_crafts(conn)
    finally:
        conn.close()

    # 合成“其他礼装/无礼装”占位对象，供 UI 只选稀有度，不暴露具体礼装
    synthetic_other = {
        0: (0, "无礼装"),
        -1: (1, "其他礼装(1★)"),
        -2: (3, "其他礼装(2★)"),
        -3: (5, "其他礼装(3★)"),
        -4: (9, "其他礼装(4★)"),
        -5: (12, "其他礼装(5★)"),
    }
    for cid, (cost, name) in synthetic_other.items():
        crafts[cid] = CraftInfo(
            id=cid,
            name=name,
            cost=cost,
            rarity=abs(cid) if cid else 0,
            bonus_type=None,
            bonus_value=0.0,
            support_bonus=0.0,
            trigger_traits=[],
            is_bond_ce=False,
            detail="",
            is_event_limited=False,
        )

    # 合成“通用5%”：把普通 5% 牵绊礼装合并为一个可重复布置的选项。
    crafts[-10] = CraftInfo(
        id=-10,
        name="通用5%",
        cost=12,
        rarity=5,
        bonus_type="universal",
        bonus_value=0.05,
        support_bonus=0.0,
        trigger_traits=[],
        is_bond_ce=True,
        detail="关卡通关时获得的牵绊点数提升5%（可重复布置）",
        is_event_limited=False,
    )

    return DataContext(servants=servants, crafts=crafts)


# ---------------------------------------------------------------------------
# 基础加成计算
# ---------------------------------------------------------------------------
def match_trait_group(traits: Set[str], group: List[str]) -> bool:
    return all(t in traits for t in group)


def trait_bonus_for_servant(
    servant_traits: Set[str], crafts: Iterable[CraftInfo]
) -> float:
    """统计特性礼装中该从者满足的加成总和。"""
    total = 0.0
    for craft in crafts:
        if craft.bonus_type != "trait" or not craft.is_bond_ce:
            continue
        # 每组条件都表示 AND；当前数据通常只有一组。若多组存在，按“满足任意一组”处理。
        if any(match_trait_group(servant_traits, g) for g in craft.trigger_traits):
            total += craft.bonus_value
    return total


def _state_score(
    ctx: DataContext,
    servant_id: int,
    state_key: str,
    player_crafts: List[CraftInfo],
) -> float:
    """某个阶段/灵衣状态下，当前队伍特性礼装能给该从者提供的加成总和。"""
    servant = ctx.servants.get(servant_id)
    if not servant:
        return 0.0
    traits = servant.traits.get(state_key, set())
    return trait_bonus_for_servant(traits, player_crafts)


def optimize_team_stages(ctx: DataContext, team: "TeamConfig") -> "TeamConfig":
    """根据队伍实际装备的特性礼装，自动为每个玩家从者选择最优阶段/灵衣。

    规则：
    - 特性收益最大者优先。
    - 若多个阶段收益相同，优先普通再临阶段；普通再临阶段内往更高的阶段取。
    - 只有普通再临阶段无法达到最高收益时，才选用灵衣状态。
    - 完全没有特性礼装时，默认取最高普通再临阶段（fourth）。
    """
    if not team.players:
        return team
    player_crafts = [
        ctx.crafts[p.craft_id] for p in team.players if p.craft_id is not None
    ]
    support_craft = (
        ctx.crafts.get(team.support_craft_id) if team.support_craft_id is not None else None
    )
    player_crafts = _effect_crafts(player_crafts, support_craft)
    stage_order = {s: i for i, s in enumerate(STAGES)}

    for p in team.players:
        if p.stage_locked:
            continue
        servant = ctx.servants.get(p.servant_id)
        if not servant or not servant.traits:
            continue
        asc_keys = [s for s in STAGES if s in servant.traits]
        costume_keys = sorted(k for k in servant.traits if k.startswith("costume_"))
        candidates = asc_keys + costume_keys
        if not candidates:
            continue

        max_score = max(
            _state_score(ctx, p.servant_id, key, player_crafts)
            for key in candidates
        )
        best_asc = [
            key
            for key in asc_keys
            if _state_score(ctx, p.servant_id, key, player_crafts) == max_score
        ]
        if best_asc:
            p.stage = max(best_asc, key=lambda key: stage_order.get(key, -1))
            continue

        # 普通再临阶段达不到最高收益，才使用灵衣状态
        best_costume = [
            key
            for key in costume_keys
            if _state_score(ctx, p.servant_id, key, player_crafts) == max_score
        ]
        if best_costume:
            # 多个灵衣收益相同时取 costume_id 较小的一个，保持稳定
            p.stage = min(
                best_costume, key=lambda key: int(key.split("_", 1)[1])
            )
    return team


def universal_bonus(crafts: Iterable[CraftInfo]) -> float:
    """玩家礼装中的通用加成总和（不含助战位）。"""
    total = 0.0
    for craft in crafts:
        if not craft.is_bond_ce:
            continue
        if craft.bonus_type in {"universal", "support_only"}:
            # support_only 若出现在玩家位没有普通加成，bonus_value 为 0
            total += craft.bonus_value
    return total


def support_craft_bonus(craft: Optional[CraftInfo]) -> float:
    """助战礼装中“助战位专属”的全队加成。

    普通通用/特性礼装放在助战位时，直接按普通礼装参与 universal/trait 计算，
    不再在这里重复叠加；这里只处理带 support_bonus 的礼装（如午茶）。
    """
    if craft is None:
        return 0.0
    if craft.support_bonus > 0:
        return craft.support_bonus
    # 兼容旧数据/手工数据：若标记 support_only 但未填 support_bonus，用 bonus_value
    if craft.bonus_type == "support_only":
        return craft.bonus_value
    return 0.0


def _effect_crafts(
    player_crafts: List[CraftInfo],
    support_craft: Optional[CraftInfo],
) -> List[CraftInfo]:
    """把“普通助战礼装”纳入全队效果礼装列表。

    规则：只有 support_bonus<=0 的普通牵绊礼装才按正常礼装参与 universal/trait；
    带独立助战加成的礼装（如午茶）不重复计入普通加成。
    """
    if support_craft is not None and support_craft.is_bond_ce and support_craft.support_bonus <= 0:
        return player_crafts + [support_craft]
    return player_crafts


def frontline_bonus(position: str, support_count: int) -> float:
    # 设计决策：UI 不区分前排/后排位置，忽略位置加成；
    # 仅保留“助战/NPC 数量”带来的全队 +4%/个 加成。
    return support_count * 0.04


def calculate_member_multiplier(
    servant_traits: Set[str],
    position: str,
    personal_bonus: float,
    player_crafts: List[CraftInfo],
    max_bond_count: int,
    activity_bonus: float,
    aura_bonus: float = 0.0,
    support_craft: Optional[CraftInfo] = None,
    support_count: int = 1,
) -> float:
    """计算单个非助战从者的最终倍率。

    公式（任务书 5.1 + 光环扩展）：
    total = (1 + frontline_bonus)
            * (1 + universal + support_craft + trait + max_bond + activity + aura)
            * (1 + personal_bonus)
    """
    front = frontline_bonus(position, support_count)
    effect_crafts = _effect_crafts(player_crafts, support_craft)
    uni = universal_bonus(effect_crafts)
    sc = support_craft_bonus(support_craft)
    tr = trait_bonus_for_servant(servant_traits, effect_crafts)
    max_bond_bonus = max_bond_count * 0.25
    return (
        (1.0 + front)
        * (1.0 + uni + sc + tr + max_bond_bonus + activity_bonus + aura_bonus)
        * (1.0 + personal_bonus)
    )


# ---------------------------------------------------------------------------
# 队伍表示与评估
# ---------------------------------------------------------------------------
@dataclass
class PlacedMember:
    position: str
    servant_id: int
    stage: str
    personal_bonus: float
    max_bond: bool
    bond_switch1: bool
    bond_switch2: bool
    aura_bonus: float = 0.0
    craft_id: Optional[int] = None
    fixed: bool = False
    stage_locked: bool = False  # True = 用户固定了阶段/灵衣，引擎不再自动改


@dataclass
class TeamConfig:
    """完整 6 人队伍：5 名玩家 + 1 个助战（或 6 名玩家）。"""
    players: List[PlacedMember]
    support_position: Optional[str] = None
    support_servant_id: Optional[int] = None
    support_craft_id: Optional[int] = None
    activity_bonus: float = 0.0


def team_cost(ctx: DataContext, team: TeamConfig) -> int:
    total = 0
    for p in team.players:
        servant = ctx.servants.get(p.servant_id)
        total += servant.cost if servant else 0
        if p.craft_id is not None:
            craft = ctx.crafts.get(p.craft_id)
            total += craft.cost if craft else 0
    return total


def calculate_team_metrics(ctx: DataContext, team: TeamConfig) -> Dict[str, Any]:
    """轻量计算队伍核心指标（不生成完整 UI 明细，用于搜索阶段提速）。"""
    if team.players:
        player_crafts = [
            ctx.crafts[p.craft_id] for p in team.players if p.craft_id is not None
        ]
    else:
        player_crafts = []

    max_bond_count = sum(
        1 for p in team.players if p.max_bond and p.bond_switch1
    )
    support_craft = (
        ctx.crafts.get(team.support_craft_id)
        if team.support_craft_id is not None
        else None
    )
    support_count = 1 if team.support_position is not None else 0
    max_bond_bonus = max_bond_count * 0.25
    activity_bonus = team.activity_bonus or 0.0
    aura_bonus = sum(float(p.aura_bonus or 0.0) for p in team.players)

    multipliers = []
    for p in team.players:
        if p.max_bond and not p.bond_switch2:
            multipliers.append(0.0)
            continue
        traits = ctx.servant_traits(p.servant_id, p.stage)
        multipliers.append(
            calculate_member_multiplier(
                servant_traits=traits,
                position=p.position,
                personal_bonus=p.personal_bonus,
                player_crafts=player_crafts,
                max_bond_count=max_bond_count,
                activity_bonus=activity_bonus,
                aura_bonus=aura_bonus,
                support_craft=support_craft,
                support_count=support_count,
            )
        )

    return {
        "totalMultiplier": sum(multipliers),
        "multipliers": multipliers,
        "maxBondCount": max_bond_count,
        "maxBondBonus": max_bond_bonus,
    }


def evaluate_team(ctx: DataContext, team: TeamConfig) -> Dict[str, Any]:
    """返回队伍评分详情。"""
    if team.players:
        player_crafts = [
            ctx.crafts[p.craft_id] for p in team.players if p.craft_id is not None
        ]
    else:
        player_crafts = []

    # 满绊共享加成只统计玩家位
    max_bond_count = sum(
        1
        for p in team.players
        if p.max_bond and p.bond_switch1
    )
    support_craft = (
        ctx.crafts.get(team.support_craft_id) if team.support_craft_id is not None else None
    )
    effect_crafts = _effect_crafts(player_crafts, support_craft)
    support_count = 1 if team.support_position is not None else 0
    max_bond_bonus = max_bond_count * 0.25
    activity_bonus = team.activity_bonus or 0.0
    aura_bonus = sum(float(p.aura_bonus or 0.0) for p in team.players)

    members: List[Dict[str, Any]] = []
    total_multiplier = 0.0
    trait_coverage: Set[str] = set()

    for p in team.players:
        servant = ctx.servants.get(p.servant_id)
        if not servant:
            continue
        traits = ctx.servant_traits(p.servant_id, p.stage)
        craft = ctx.crafts.get(p.craft_id) if p.craft_id is not None else None

        # 满绊且关闭开关二：个人收益为 0，但仍占位
        if p.max_bond and not p.bond_switch2:
            multiplier = 0.0
            personal_bonus_used = p.personal_bonus
        else:
            multiplier = calculate_member_multiplier(
                servant_traits=traits,
                position=p.position,
                personal_bonus=p.personal_bonus,
                player_crafts=player_crafts,
                max_bond_count=max_bond_count,
                activity_bonus=activity_bonus,
                aura_bonus=aura_bonus,
                support_craft=support_craft,
                support_count=support_count,
            )
            personal_bonus_used = p.personal_bonus
            for craft_item in effect_crafts:
                if craft_item.bonus_type != "trait":
                    continue
                if any(
                    match_trait_group(traits, g)
                    for g in craft_item.trigger_traits
                ):
                    for g in craft_item.trigger_traits:
                        trait_coverage.update(g)

        total_multiplier += multiplier
        members.append(
            {
                "position": p.position,
                "servantId": p.servant_id,
                "name": servant.name,
                "stage": p.stage,
                "isSupport": False,
                "isFixed": p.fixed,
                "isMaxBond": p.max_bond,
                "craftId": p.craft_id,
                "craftName": craft.name if craft else "",
                "craftType": "bond" if (craft and craft.is_bond_ce) else "other",
                "bonusDetail": {
                    "frontlineBonus": (
                        frontline_bonus(p.position, support_count) - (support_count * 0.04)
                        if False else frontline_bonus(p.position, support_count)
                    ),
                    "universalCraftBonus": universal_bonus(effect_crafts),
                    "supportCraftBonus": support_craft_bonus(support_craft),
                    "traitCraftBonus": trait_bonus_for_servant(traits, effect_crafts),
                    "maxBondBonus": max_bond_bonus,
                    "activityBonus": activity_bonus,
                    "auraBonus": round(aura_bonus, 4),
                    "personalBonus": personal_bonus_used,
                    "totalMultiplier": round(multiplier, 6),
                },
            }
        )

    # 助战成员（不计收益、不参与特性、不占 Cost）
    support_member = None
    if team.support_position is not None and team.support_servant_id is not None:
        servant = ctx.servants.get(team.support_servant_id)
        craft = (
            ctx.crafts.get(team.support_craft_id)
            if team.support_craft_id is not None
            else None
        )
        support_member = {
            "position": team.support_position,
            "servantId": team.support_servant_id,
            "name": servant.name if servant else "",
            "stage": "fourth",
            "isSupport": True,
            "isFixed": False,
            "isMaxBond": False,
            "craftId": team.support_craft_id,
            "craftName": craft.name if craft else "",
            "craftType": "bond" if (craft and craft.is_bond_ce) else "other",
            "bonusDetail": {
                "frontlineBonus": 0.0,
                "universalCraftBonus": 0.0,
                "supportCraftBonus": 0.0,
                "traitCraftBonus": 0.0,
                "maxBondBonus": 0.0,
                "activityBonus": 0.0,
                "auraBonus": 0.0,
                "personalBonus": 0.0,
                "totalMultiplier": 0.0,
            },
        }

    all_members = members + ([support_member] if support_member else [])
    # 按位置顺序排序，方便 UI
    pos_order = {pos: i for i, pos in enumerate(POSITIONS)}
    all_members.sort(key=lambda m: pos_order.get(m["position"], 99))

    return {
        "totalMultiplier": round(total_multiplier, 6),
        "costUsed": team_cost(ctx, team),
        "team": all_members,
        "maxBondStats": {
            "count": max_bond_count,
            "totalBonus": round(max_bond_bonus, 4),
        },
        "traitCoverage": sorted(trait_coverage),
    }
