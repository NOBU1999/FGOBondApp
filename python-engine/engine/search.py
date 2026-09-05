"""Task 2：组合搜索/推荐算法。

实现思路
--------
- 固定从者、固定礼装先落位。
- 未固定玩家位从 Box 候选中选人；候选池按启发式截断，避免组合爆炸。
- 未固定礼装位从牵绊加成礼装池中选礼装（礼装效果是全队共享，因此只关心“选了哪些礼装”）。
- 自动助战从剩余 Box 中选一个；助战礼装默认参与计算但不自动锁定午茶，未手动选择时按普通通用礼装参与优化；用户显式选择“无礼装”时才无礼装。
- 对每个可组队方案调用 calculator.evaluate_team 计算总倍率并排序。

说明
----
当前实现偏向“可运行 + 足够快”，后续可在搜索精度/剪枝上继续增强。
"""

from __future__ import annotations

import itertools
import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from . import calculator
from .calculator import DataContext, PlacedMember, TeamConfig
from .models import (
    FRONT_POSITIONS,
    POSITIONS,
    STRATEGY_BALANCED,
    STRATEGY_TARGET_MAX,
    BoxServant,
    CalculationRequest,
    FixedCraft,
    FixedServant,
    SupportConfig,
)
from . import models


# 合成礼装 ID：-10 表示“通用5%”，允许在玩家位重复布置。
GENERIC_UNIVERSAL5_ID = -10
REPEATABLE_BOND_IDS = frozenset({GENERIC_UNIVERSAL5_ID})


# ---------------------------------------------------------------------------
# 布局准备
# ---------------------------------------------------------------------------
@dataclass
class PlayerSlot:
    position: str
    fixed_servant_id: Optional[int] = None
    fixed_craft_id: Optional[int] = None
    fixed_craft_type: Optional[str] = None  # bond / other


@dataclass
class Blueprint:
    support_position: str
    support_servant_id: Optional[int]  # None = auto
    support_craft_id: Optional[int]    # None = auto
    player_slots: List[PlayerSlot] = field(default_factory=list)
    fixed_player_members: List[PlacedMember] = field(default_factory=list)
    free_servant_positions: List[str] = field(default_factory=list)
    # 没有固定礼装、可放牵绊礼装的玩家位
    free_bond_positions: List[str] = field(default_factory=list)
    fixed_bond_craft_ids: List[int] = field(default_factory=list)
    fixed_other_craft_ids: List[int] = field(default_factory=list)
    fixed_servant_ids: Set[int] = field(default_factory=set)


def _box_map(req: CalculationRequest) -> Dict[int, BoxServant]:
    return {b.servant_id: b for b in req.box}


def _choose_support_position(
    req: CalculationRequest,
    player_slots: List[PlayerSlot],
) -> str:
    if req.support and req.support.position:
        return req.support.position
    occupied = {s.position for s in player_slots}
    # 默认后排右
    if "back_right" not in occupied:
        return "back_right"
    for pos in POSITIONS:
        if pos not in occupied:
            return pos
    # 全部被占用时，最后一个位置做助战位（会挤掉一个玩家位）
    return POSITIONS[-1]


def prepare_blueprint(req: CalculationRequest, ctx: DataContext) -> Blueprint:
    """根据请求生成队伍布局。"""
    box = _box_map(req)
    # 支持位
    # 先按固定从者/礼装位置占用情况做初步检查，随后再选 support position
    raw_slots = {pos: PlayerSlot(position=pos) for pos in POSITIONS}

    # 固定从者
    used_positions: Set[str] = set()
    fixed_servant_ids: Set[int] = set()
    fixed_player_members: List[PlacedMember] = []

    # 如果用户没给固定从者位置，按顺序从前排开始分配
    fixed_servants = list(req.fixed_servants)
    unspecified = [fs for fs in fixed_servants if not fs.position]
    specified = [fs for fs in fixed_servants if fs.position]
    # 预占指定位置
    for fs in specified:
        if fs.servant_id in fixed_servant_ids:
            raise ValueError(f"固定从者重复: {fs.servant_id}")
        if fs.position not in POSITIONS:
            raise ValueError(f"未知位置: {fs.position}")
        if fs.position in used_positions:
            raise ValueError(f"固定从者位置冲突: {fs.position}")
        used_positions.add(fs.position)
        fixed_servant_ids.add(fs.servant_id)
        raw_slots[fs.position].fixed_servant_id = fs.servant_id

    for pos in POSITIONS:
        if pos not in used_positions and unspecified:
            fs = unspecified.pop(0)
            if fs.servant_id in fixed_servant_ids:
                raise ValueError(f"固定从者重复: {fs.servant_id}")
            used_positions.add(pos)
            fixed_servant_ids.add(fs.servant_id)
            raw_slots[pos].fixed_servant_id = fs.servant_id

    if unspecified:
        raise ValueError("固定从者位置不足")

    # 固定礼装
    used_craft_positions: Set[str] = set()
    fixed_bond_ids: List[int] = []
    fixed_other_ids: List[int] = []
    for fc in req.fixed_crafts:
        if fc.position not in POSITIONS:
            raise ValueError(f"未知礼装位置: {fc.position}")
        if fc.position in used_craft_positions:
            raise ValueError(f"固定礼装位置冲突: {fc.position}")
        craft = ctx.crafts.get(fc.craft_id)
        if craft is None:
            raise ValueError(f"礼装不存在: {fc.craft_id}")
        # 英灵逢魔系列全局排除：即使是旧预设固定了也忽略，让该位置回退为自由位
        if fc.type == "bond" and _is_ouma_craft(ctx, fc.craft_id):
            continue
        used_craft_positions.add(fc.position)
        raw_slots[fc.position].fixed_craft_id = fc.craft_id
        raw_slots[fc.position].fixed_craft_type = fc.type
        if fc.type == "bond":
            fixed_bond_ids.append(fc.craft_id)
        else:
            fixed_other_ids.append(fc.craft_id)

    # 助战位不能与固定礼装位冲突；助战从者允许和玩家位重复（与助战礼装规则一致）
    manual_support = SupportConfig(
        servant_id=req.support.servant_id if req.support else None,
        craft_id=req.support.craft_id if req.support else None,
        position=req.support.position if req.support else None,
    )
    # 英灵逢魔系列全局排除：助战固定了也按“未指定礼装”处理
    if manual_support.craft_id is not None and _is_ouma_craft(ctx, manual_support.craft_id):
        manual_support.craft_id = None

    player_slots = [s for s in raw_slots.values()]
    support_position = _choose_support_position(req, player_slots)
    # 若 support 位被固定从者占用且手动指定了助战位，报错
    support_slot = raw_slots[support_position]
    if support_slot.fixed_servant_id is not None:
        raise ValueError(f"助战位与固定从者冲突: {support_position}")
    if support_slot.fixed_craft_id is not None:
        raise ValueError(f"助战位与固定礼装冲突: {support_position}")

    # 玩家位 = 除 support_position 外的 5 个位置
    player_slots = [raw_slots[pos] for pos in POSITIONS if pos != support_position]

    # 组装 fixed player members
    fixed_stage_by_position = {
        fs.position: fs.stage for fs in req.fixed_servants if fs.position
    }
    for slot in player_slots:
        if slot.fixed_servant_id is None:
            continue
        bs = box.get(slot.fixed_servant_id)
        if bs is None:
            raise ValueError(f"固定从者不在 Box 中: {slot.fixed_servant_id}")
        user_stage = fixed_stage_by_position.get(slot.position)
        fixed_player_members.append(
            PlacedMember(
                position=slot.position,
                servant_id=slot.fixed_servant_id,
                stage=user_stage or bs.stage,
                personal_bonus=bs.personal_bonus,
                aura_bonus=bs.aura_bonus,
                max_bond=bs.max_bond,
                bond_switch1=bs.bond_switch1,
                bond_switch2=bs.bond_switch2,
                craft_id=slot.fixed_craft_id,
                fixed=True,
                stage_locked=user_stage is not None,
            )
        )

    free_servant_positions = [
        s.position for s in player_slots if s.fixed_servant_id is None
    ]
    free_bond_positions = [
        s.position for s in player_slots if s.fixed_craft_id is None
    ]

    bp = Blueprint(
        support_position=support_position,
        support_servant_id=manual_support.servant_id,
        support_craft_id=manual_support.craft_id,
        player_slots=player_slots,
        fixed_player_members=fixed_player_members,
        free_servant_positions=free_servant_positions,
        free_bond_positions=free_bond_positions,
        fixed_bond_craft_ids=fixed_bond_ids,
        fixed_other_craft_ids=fixed_other_ids,
        fixed_servant_ids=fixed_servant_ids,
    )
    return bp


# ---------------------------------------------------------------------------
# 候选池与启发式
# ---------------------------------------------------------------------------
def _max_possible_trait_bonus(
    ctx: DataContext,
    servant_id: int,
    trait_craft_ids: Sequence[int],
) -> float:
    """该从者在所有普通再临阶段/灵衣状态下能获得的最高特性礼装收益。

    用于候选池/启发式：即使当前默认阶段不满足某特性，只要某个阶段或灵衣
    能满足，也应把该从者当作潜在受益者参与排序。
    """
    info = ctx.servants.get(servant_id)
    if not info or not info.traits:
        return 0.0
    best = 0.0
    for traits in info.traits.values():
        total = 0.0
        for cid in trait_craft_ids:
            craft = ctx.crafts.get(cid)
            if craft and any(
                calculator.match_trait_group(traits, g)
                for g in craft.trigger_traits
            ):
                total += craft.bonus_value
        if total > best:
            best = total
    return best


def _servant_heuristic(
    ctx: DataContext,
    bs: BoxServant,
    trait_craft_ids: Sequence[int],
) -> float:
    score = 1.0 + bs.personal_bonus
    if bs.aura_bonus:
        score += bs.aura_bonus * 5.0  # 全队光环按 5 个玩家位收益估算
    if bs.max_bond and bs.bond_switch1:
        score += 1.0  # 能提供全队 25%
    if bs.max_bond and not bs.bond_switch2:
        # 自身不计收益，作为玩家位价值下降；但作为助战无所谓
        score -= 0.8
    score += _max_possible_trait_bonus(ctx, bs.servant_id, trait_craft_ids) * 3.0
    return score


def _reduce_candidate_ids(
    ctx: DataContext,
    candidates: Sequence[int],
    choose_count: int,
    max_combos: int,
    box: Dict[int, BoxServant],
    trait_craft_ids: Sequence[int],
) -> List[int]:
    if choose_count <= 0:
        return list(candidates)
    scored = sorted(
        candidates,
        key=lambda sid: _servant_heuristic(ctx, box[sid], trait_craft_ids),
        reverse=True,
    )
    k = len(scored)
    while k > choose_count and math.comb(k, choose_count) > max_combos:
        k -= 1
    return scored[:k]


def _trait_craft_ids(ctx: DataContext) -> List[int]:
    return [
        cid
        for cid, c in ctx.crafts.items()
        if c.is_bond_ce
        and c.bonus_type == "trait"
        and not _is_ouma_craft(ctx, cid)
    ]


# ---------------------------------------------------------------------------
# 生成玩家组合与礼装组合
# ---------------------------------------------------------------------------
def _front_back_counts(positions: Sequence[str]) -> Tuple[int, int]:
    return (
        sum(1 for p in positions if p in FRONT_POSITIONS),
        sum(1 for p in positions if p not in FRONT_POSITIONS),
    )


def _split_extras_for_slots(
    extras: Sequence[int],
    free_positions: Sequence[str],
) -> Iterable[Dict[str, List[int]]]:
    """把选出的额外从者分配到 free_positions。

    同排内部等价，因此只枚举“哪些人去前排”。
    """
    free_front, free_back = _front_back_counts(free_positions)
    if free_front == 0 and free_back == 0:
        yield {}
        return
    if len(extras) != len(free_positions):
        return
    front_positions = [p for p in free_positions if p in FRONT_POSITIONS]
    back_positions = [p for p in free_positions if p not in FRONT_POSITIONS]
    for front_ids_tuple in itertools.combinations(extras, free_front):
        front_ids = set(front_ids_tuple)
        back_ids = [x for x in extras if x not in front_ids]
        mapping = {}
        for pos, sid in zip(front_positions, front_ids_tuple):
            mapping[pos] = sid
        for pos, sid in zip(back_positions, back_ids):
            mapping[pos] = sid
        yield mapping


def _generate_servant_combinations(
    candidate_ids: Sequence[int],
    choose_count: int,
) -> Iterable[Tuple[int, ...]]:
    if choose_count == 0:
        yield ()
        return
    yield from itertools.combinations(candidate_ids, choose_count)


def _is_merged_generic_universal5(ctx: DataContext, craft_id: int) -> bool:
    """是否属于被 UI 合并成“通用5%”的普通 5% 牵绊礼装。

    这类礼装不再以单独卡面进入自由推荐池，统一由合成 ID -10 表示并可重复。
    """
    craft = ctx.crafts.get(craft_id)
    if craft is None:
        return False
    return (
        craft_id != GENERIC_UNIVERSAL5_ID
        and craft.is_bond_ce
        and craft.bonus_type == "universal"
        and abs(craft.bonus_value - 0.05) < 1e-9
        and craft.support_bonus <= 0
    )


def _is_event_limited_craft(ctx: DataContext, craft_id: int) -> bool:
    craft = ctx.crafts.get(craft_id)
    if craft is None:
        return False
    if craft.is_event_limited:
        return True
    detail = craft.detail or ""
    low = detail.lower()
    markers = ("活动限定", "event only", "event limited", "イベント限定")
    return any(m in low for m in markers)


def _is_ouma_craft(ctx: DataContext, craft_id: int) -> bool:
    """英灵逢魔系列：用户明确要求不进入推荐/自动池，也不参与启发式评分。"""
    craft = ctx.crafts.get(craft_id)
    if craft is None:
        return False
    name = craft.name or ""
    return "英灵逢魔" in name


def _generate_craft_combinations(
    candidate_craft_ids: Sequence[int],
    free_slots_count: int,
    max_total: int = 200000,
) -> List[Tuple[int, ...]]:
    """生成礼装组合。

    默认只生成“尽量填满所有空位”的组合，速度优先。
    如果调用方发现没有可行解，可再 allow_partial=True 生成小数量组合。
    """
    if free_slots_count <= 0:
        return [()]
    result: List[Tuple[int, ...]] = []
    # 先只生成完整数量（通常 Cost 足够时最优）
    size = min(free_slots_count, len(candidate_craft_ids))
    for c in itertools.combinations(candidate_craft_ids, size):
        result.append(tuple(c))
        if len(result) >= max_total:
            break
    return result


def _generate_craft_combinations_partial(
    candidate_craft_ids: Sequence[int],
    free_slots_count: int,
    max_total: int = 200000,
) -> List[Tuple[int, ...]]:
    """生成 0..free_slots_count 的组合，供 Cost 不足时兜底。"""
    if free_slots_count <= 0:
        return [()]
    result: List[Tuple[int, ...]] = []
    for size in range(min(free_slots_count, len(candidate_craft_ids)), -1, -1):
        for c in itertools.combinations(candidate_craft_ids, size):
            result.append(tuple(c))
            if len(result) >= max_total:
                return result
    return result


def _generate_multiset_combinations(
    candidate_craft_ids: Sequence[int],
    size: int,
    repeatable_ids: Set[int],
) -> Iterable[Tuple[int, ...]]:
    """生成允许部分礼装重复的礼装组合。

    - 非可重复礼装最多出现一次；
    - 可重复礼装（当前为“通用5%”）可出现多次。
    """
    for combo in itertools.combinations_with_replacement(candidate_craft_ids, size):
        counts = {}
        ok = True
        for cid in combo:
            counts[cid] = counts.get(cid, 0) + 1
            if counts[cid] > 1 and cid not in repeatable_ids:
                ok = False
                break
        if ok:
            yield tuple(combo)


def _time_budget_seconds(req: CalculationRequest) -> float:
    return max(1.0, req.timeout_ms / 1000.0)


def _default_servant_combo_limit(req: CalculationRequest) -> int:
    """按等待时间动态决定从者候选组合上限，等待越久搜索越广。"""
    return max(80, min(2000, int(_time_budget_seconds(req) * 12)))


def _default_craft_combo_limit(req: CalculationRequest) -> int:
    """大 Box 下控制单组从者要尝试的礼装组合数量，避免组合爆炸。"""
    base = req.craft_pool_size * 10
    dynamic = int(_time_budget_seconds(req) * 20)
    return max(100, min(4000, max(base, dynamic)))


def _generate_craft_combinations_with_cost(
    ctx: DataContext,
    candidate_craft_ids: Sequence[int],
    free_slots_count: int,
    max_total: int = 200000,
) -> List[Tuple[int, Tuple[int, ...]]]:
    """生成 0..free_slots_count 的礼装组合，并带上礼装总Cost。

    返回 [(craftCost, craftIds), ...]，排序为“礼装数量多优先、Cost小优先”。
    """
    if free_slots_count <= 0:
        return [(0, ())]
    result: List[Tuple[int, Tuple[int, ...]]] = []
    seen: set = set()
    # 可重复礼装能填满所有空位，因此最大数量直接按空位数生成。
    max_size = free_slots_count
    stopped_size: Optional[int] = None
    for size in range(max_size, -1, -1):
        for c in _generate_multiset_combinations(
            candidate_craft_ids, size, set(REPEATABLE_BOND_IDS)
        ):
            cost = sum(ctx.crafts[cid].cost for cid in c)
            entry = (cost, tuple(c))
            if entry not in seen:
                result.append(entry)
                seen.add(entry)
            if len(result) >= max_total:
                stopped_size = size
                break
        if stopped_size is not None:
            break

    # 如果截断发生在大尺寸组合上（如 5 张礼装），较低尺寸的 4/3/2/1/0
    # 可能完全没被生成，导致 Cost 只够 2~3 张时结果却全部“无礼装”。
    # 这里为每个较小尺寸补少量代表性组合，保证 Cost 不足时仍有礼装可用。
    if stopped_size is not None and stopped_size > 0:
        for size in range(stopped_size - 1, -1, -1):
            added = 0
            for c in _generate_multiset_combinations(
                candidate_craft_ids, size, set(REPEATABLE_BOND_IDS)
            ):
                cost = sum(ctx.crafts[cid].cost for cid in c)
                entry = (cost, tuple(c))
                if entry not in seen:
                    result.append(entry)
                    seen.add(entry)
                    added += 1
                    if added >= 3:
                        break

    # 确保有空礼装兜底
    if (0, ()) not in seen:
        result.append((0, ()))
        seen.add((0, ()))

    # 按预期收益排序：礼装越多通常收益越高；同数量下低Cost优先
    result.sort(key=lambda x: (-len(x[1]), x[0]))
    return result


def _greedy_mapping(
    ctx: DataContext,
    box: Dict[int, BoxServant],
    extras: Sequence[int],
    free_positions: Sequence[str],
) -> Dict[str, int]:
    """启发式分配：潜力高的从者放前排，减少位置排列爆炸。"""
    if not extras:
        return {}
    trait_ids = _trait_craft_ids(ctx)
    scored = sorted(
        extras,
        key=lambda sid: _servant_heuristic(ctx, box[sid], trait_ids),
        reverse=True,
    )
    front_positions = [p for p in free_positions if p in FRONT_POSITIONS]
    back_positions = [p for p in free_positions if p not in FRONT_POSITIONS]
    mapping = {}
    idx = 0
    for pos in front_positions + back_positions:
        if idx < len(scored):
            mapping[pos] = scored[idx]
            idx += 1
    return mapping


# ---------------------------------------------------------------------------
# 组队与主入口
# ---------------------------------------------------------------------------
def _make_team_config(
    ctx: DataContext,
    req: CalculationRequest,
    bp: Blueprint,
    chosen_extras: Sequence[int],
    mapping: Dict[str, int],
    craft_choice: Sequence[int],
    support_servant_id: int,
    support_craft_id: Optional[int],
) -> Optional[TeamConfig]:
    box = _box_map(req)
    # 必须复制固定成员，不能直接复用 bp.fixed_player_members 里的对象：
    # 否则首次给固定位分配礼装后，后续方案会沿用上一次的 craft_id，导致搜索失效。
    players: List[PlacedMember] = [
        PlacedMember(
            position=p.position,
            servant_id=p.servant_id,
            stage=p.stage,
            personal_bonus=p.personal_bonus,
            aura_bonus=p.aura_bonus,
            max_bond=p.max_bond,
            bond_switch1=p.bond_switch1,
            bond_switch2=p.bond_switch2,
            craft_id=p.craft_id,
            fixed=p.fixed,
            stage_locked=p.stage_locked,
        )
        for p in bp.fixed_player_members
    ]

    # 先补充固定玩家位置的 craft（如果固定礼装与固定从者同位置已在 fixed member 中体现）
    # 把 free_bond_positions 按顺序与 craft_choice 配对
    craft_iter = iter(craft_choice)

    # 处理所有玩家位置（固定/自由统一构建）
    for slot in bp.player_slots:
        # 固定从者成员已在 fixed_player_members，跳过重建，但需要确保其 craft_id 正确
        if slot.fixed_servant_id is not None:
            continue
        sid = mapping.get(slot.position)
        if sid is None:
            continue
        bs = box.get(sid)
        if bs is None:
            return None
        craft_id = slot.fixed_craft_id
        if craft_id is None:
            # 若该位置是可放牵绊礼装的位置，则取 craft_choice 中的下一张
            craft_id = next(craft_iter, None)
        players.append(
            PlacedMember(
                position=slot.position,
                servant_id=sid,
                stage=bs.stage,
                personal_bonus=bs.personal_bonus,
                aura_bonus=bs.aura_bonus,
                max_bond=bs.max_bond,
                bond_switch1=bs.bond_switch1,
                bond_switch2=bs.bond_switch2,
                craft_id=craft_id,
                fixed=False,
            )
        )

    # 如果固定从者位置没有固定礼装，且属于 free_bond_positions，则也应获得 craft_choice 中的礼装。
    # 上面的逻辑只给非固定从者分配了礼装；下面修正固定从者的空礼装位。
    # 先收集已分配 craft 的位置
    assigned_craft_positions = {
        p.position for p in players if p.craft_id is not None
    }
    missing_fixed = [
        p
        for p in players
        if p.craft_id is None and p.position in bp.free_bond_positions
    ]
    for p in missing_fixed:
        p.craft_id = next(craft_iter, None)

    if len(players) != 5:
        return None

    # 排序不重要，TeamConfig 内部处理
    return TeamConfig(
        players=players,
        support_position=bp.support_position,
        support_servant_id=support_servant_id,
        support_craft_id=support_craft_id,
        activity_bonus=req.activity_bonus,
    )


def _choose_support(
    ctx: DataContext,
    req: CalculationRequest,
    used_servant_ids: Set[int],
    box: Dict[int, BoxServant],
) -> Optional[int]:
    if req.support and req.support.servant_id is not None:
        sid = req.support.servant_id
        # 手动指定助战允许与玩家位重复；只校验从者存在于本地数据
        if sid not in ctx.servants:
            return None
        return sid

    # 自动助战：助战从者本身不参与收益优化，也不占用玩家位，
    # 因此只要随便选一个未被排除的从者作为展示即可。
    candidates = [
        sid for sid in ctx.servants
        if sid not in req.excluded_servant_ids
    ]
    return min(candidates) if candidates else None


def _servant_can_match_craft_any_stage(
    ctx: DataContext,
    servant_id: int,
    craft: Any,
) -> bool:
    """该从者是否在某个阶段/灵衣下能满足某张特性礼装的条件。"""
    info = ctx.servants.get(servant_id)
    if not info or not info.traits:
        return False
    for traits in info.traits.values():
        if any(calculator.match_trait_group(traits, g) for g in craft.trigger_traits):
            return True
    return False


def _filter_support_options_for_team(
    ctx: DataContext,
    options: Sequence[int],
    player_ids: Sequence[int],
) -> List[int]:
    """按当前玩家阵容过滤助战候选，减少无意义枚举。

    - 午茶/通用礼装保留；
    - 特性礼装只保留至少一位玩家能通过某阶段/灵衣满足条件的。
    """
    result: List[int] = []
    trait_scores: List[Tuple[int, int, int]] = []
    player_set = set(player_ids)
    for cid in options:
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        if _is_ouma_craft(ctx, cid):
            continue
        # 手动指定的“无礼装/其他礼装”占位也要保留，否则助战会无候选导致无解
        if not craft.is_bond_ce and craft.bonus_type is None:
            result.append(cid)
            continue
        if craft.support_bonus > 0:
            result.append(cid)  # 午茶：助战专属高加成
            continue
        if craft.bonus_type == "universal" and craft.bonus_value >= 0.1:
            result.append(cid)  # 午餐 10%：高于 5% 通用，自动时保留即可
            continue
        if craft.bonus_type == "support_only":
            result.append(cid)
            continue
        if craft.bonus_type == "trait":
            count = sum(
                1
                for sid in player_set
                if _servant_can_match_craft_any_stage(ctx, sid, craft)
            )
            if count > 0:
                trait_scores.append((count, craft.bonus_value, cid))
    # 只保留最可能超过午茶/午餐的特性礼装，避免每套阵容枚举全部特性礼装
    trait_scores.sort(key=lambda x: (-x[0], -x[1], x[2]))
    result.extend(cid for _, _, cid in trait_scores[:2])
    return result


def _support_craft_options(ctx: DataContext, req: CalculationRequest) -> List[int]:
    """生成助战位候选礼装列表。

    - 用户手动指定助战礼装（包括显式选午茶或无礼装 0）时，只使用该礼装；
    - 未指定时，把午茶、普通通用、特性礼装都作为候选参与搜索，
      由实际收益决定最优助战礼装（如全队兽科时 NFF 可能优于午茶）。
    """
    if req.support and req.support.craft_id is not None:
        cid = req.support.craft_id
        return [cid] if cid in ctx.crafts else []

    options: List[int] = []
    for cid, craft in ctx.crafts.items():
        if not craft.is_bond_ce:
            continue
        if _is_event_limited_craft(ctx, cid):
            continue
        if _is_ouma_craft(ctx, cid):
            continue
        if _is_merged_generic_universal5(ctx, cid):
            continue
        if not (craft.bonus_value > 0.025 or craft.support_bonus > 0.025):
            continue
        options.append(cid)
    # 让高价值候选排在前面，便于后续截断/稳定
    options.sort(key=lambda cid: (
        ctx.crafts[cid].bonus_type != "universal",
        -ctx.crafts[cid].bonus_value,
        -ctx.crafts[cid].support_bonus,
    ))
    return options[: req.craft_pool_size + 1]


def _solution_dict(result: Dict[str, Any], rank: int) -> Dict[str, Any]:
    return {
        "rank": rank,
        "totalMultiplier": result["totalMultiplier"],
        "costUsed": result["costUsed"],
        "team": result["team"],
        "maxBondStats": result["maxBondStats"],
        "traitCoverage": result["traitCoverage"],
    }


def search_top_teams(
    ctx: DataContext,
    req: CalculationRequest,
    progress: Optional[Any] = None,
) -> Dict[str, Any]:
    """执行搜索并返回 Top N。"""
    start = time.time()
    box = _box_map(req)
    if not req.box:
        raise ValueError("请至少勾选一位从者")

    def report(msg: str) -> None:
        if progress:
            progress(msg)
        else:
            pass

    bp = prepare_blueprint(req, ctx)

    if len(bp.fixed_servant_ids) > 6:
        raise ValueError("固定从者不能超过6人")

    choose_count = len(bp.free_servant_positions)
    # 候选从者：Box 中未被固定玩家使用的。
    # 助战位从者不占用玩家位，也不参与“选谁收益最大”的优化，因此不排除它。
    fixed_player_ids = set(bp.fixed_servant_ids)
    player_candidates = [
        sid for sid, bs in box.items()
        if sid not in fixed_player_ids
        and sid not in req.excluded_servant_ids
    ]

    # Cost 可行性预检：如果“最省配置”都超上限，提前给出明确提示
    fixed_cost = 0
    for slot in bp.player_slots:
        if slot.fixed_servant_id is not None:
            s_info = ctx.servants.get(slot.fixed_servant_id)
            if s_info:
                fixed_cost += s_info.cost
        if slot.fixed_craft_id is not None:
            c_info = ctx.crafts.get(slot.fixed_craft_id)
            if c_info:
                if c_info.support_bonus > 0:
                    raise ValueError("迦勒底午茶时光等助战加成礼装只能放在助战位")
                fixed_cost += c_info.cost
    if choose_count > len(player_candidates):
        raise ValueError("Box 人数不足，无法组成 5 名玩家 + 助战的队伍")
    min_extra_cost = sum(
        sorted(ctx.servants[sid].cost for sid in player_candidates)[:choose_count]
    )
    min_total_cost = fixed_cost + min_extra_cost
    if min_total_cost > req.cost_limit:
        raise ValueError(f"当前配置下最小Cost为{min_total_cost}，请提高上限")

    trait_ids = _trait_craft_ids(ctx)
    # 固定礼装已占用的牵绊礼装不再进入可挑选池（不重复使用同一张）。
    # 例外：可重复的“通用5%”即使已固定，仍允许继续放入自由位。
    used_craft_ids = {
        cid for cid in bp.fixed_bond_craft_ids
        if cid not in REPEATABLE_BOND_IDS
    }
    bond_candidates = [
        cid for cid, craft in ctx.crafts.items()
        if craft.is_bond_ce
        and cid not in used_craft_ids
        and cid not in req.excluded_craft_ids
        and not _is_merged_generic_universal5(ctx, cid)
        and not _is_event_limited_craft(ctx, cid)
        and not _is_ouma_craft(ctx, cid)
        # 需求过滤：满破 2.5% 及以下的低价值牵绊礼装不进入推荐池
        and (craft.bonus_value > 0.025 or craft.support_bonus > 0.025)
        # 午茶等带“助战加成”的礼装只能放助战位，不能进玩家自由位
        and craft.support_bonus <= 0
    ]
    bond_candidates.sort(key=lambda cid: (
        ctx.crafts[cid].bonus_type != "universal",
        -ctx.crafts[cid].bonus_value,
        -ctx.crafts[cid].support_bonus,
    ))

    # 候选礼装截断
    craft_pool = bond_candidates[: req.craft_pool_size]
    if not craft_pool and len(bp.free_bond_positions) > 0:
        # 没有牵绊礼装时仍可组队，使用空礼装组合
        pass

    fixed_craft_cost = sum(
        ctx.crafts[slot.fixed_craft_id].cost
        for slot in bp.player_slots
        if slot.fixed_craft_id is not None
    )

    # 候选从者截断，使组合数量可控
    report("正在生成候选池...")
    reduced = _reduce_candidate_ids(
        ctx,
        player_candidates,
        choose_count,
        max_combos=_default_servant_combo_limit(req),
        box=box,
        trait_craft_ids=trait_ids,
    )
    # target_max：保证目标从者一定进入候选池
    if (
        req.strategy == STRATEGY_TARGET_MAX
        and req.target_servant_id is not None
        and req.target_servant_id in player_candidates
        and req.target_servant_id not in reduced
    ):
        reduced.append(req.target_servant_id)

    # 启发式截断可能丢掉低Cost从者，导致“满礼装组合”因 Cost 不足而整体无解。
    # 按 Cost 从低到高补回必要候选，但只补到“至少有一套满自由礼装组合在 Cost 内可行”
    # 即停。原实现会把所有低Cost从者都追加进来，使候选组合数远超预算；
    # 枚举顺序又总是先枚举含最高启发式从者的组合，导致时间预算内全是不含替代组合的
    # 同核心队伍（用户简易排除后无其他队伍）。
    if choose_count > 0 and craft_pool and bp.free_bond_positions:
        max_free_bond_cost = max(
            (ctx.crafts[cid].cost for cid in craft_pool),
            default=0,
        ) * len(bp.free_bond_positions)

        def has_feasible_full_combo(pool: Sequence[int]) -> bool:
            costs = sorted(
                (ctx.servants[x].cost for x in pool if x in ctx.servants)
            )[:choose_count]
            return (
                len(costs) == choose_count
                and sum(costs) + fixed_craft_cost + max_free_bond_cost <= req.cost_limit
            )

        # 如果现有启发式候选已经可行，就不需要追加任何低Cost从者。
        if not has_feasible_full_combo(reduced):
            for sid in sorted(
                player_candidates,
                key=lambda x: (ctx.servants[x].cost if x in ctx.servants else 99, x),
            ):
                if sid in reduced:
                    continue
                if len(reduced) >= len(player_candidates):
                    break
                trial = set(reduced)
                trial.add(sid)
                if has_feasible_full_combo(list(trial)):
                    reduced.append(sid)
                    # 一旦池内已经存在可行组合，立即停止，避免候选池无限膨胀。
                    if has_feasible_full_combo(reduced):
                        break

    report("正在搜索组合...")
    free_slots_count = len(bp.free_bond_positions)
    craft_combos_with_cost = _generate_craft_combinations_with_cost(
        ctx, craft_pool, free_slots_count,
        max_total=_default_craft_combo_limit(req),
    )

    support_servant_id = bp.support_servant_id
    # 助战礼装位参与计算：未手动指定时枚举午茶/普通通用/特性礼装，
    # 按队伍实际收益决定；用户显式选“没有（无礼装）”传 0 时不填。
    support_craft_options = _support_craft_options(ctx, req)

    solutions: List[Dict[str, Any]] = []
    best_by_set: Dict[Tuple[int, ...], Dict[str, Any]] = {}
    seen: Set[Tuple[Any, ...]] = set()
    processed_total = 0
    evaluated_total = 0
    timeout_seconds = req.timeout_ms / 1000.0

    def run_with_craft_combos() -> None:
        nonlocal solutions, seen, processed_total, evaluated_total
        processed = 0
        for extras_tuple in _generate_servant_combinations(reduced, choose_count):
            # 时间预算
            if time.time() - start > req.timeout_ms / 1000:
                report("达到时间预算，提前结束搜索")
                break

            used_players = set(bp.fixed_servant_ids) | set(extras_tuple)
            if (
                req.strategy == STRATEGY_TARGET_MAX
                and req.target_servant_id is not None
                and req.target_servant_id not in used_players
            ):
                continue

            support_id = support_servant_id
            if support_id is None:
                support_id = _choose_support(ctx, req, used_players, box)
                if support_id is None:
                    continue

            mapping = _greedy_mapping(
                ctx, box, extras_tuple, bp.free_servant_positions
            )

            # 玩家从者 Cost + 固定礼装 Cost 后，剩余才是可分配给自由礼装位的预算
            servant_cost = sum(ctx.servants[sid].cost for sid in used_players if sid in ctx.servants)
            ce_budget = req.cost_limit - servant_cost - fixed_craft_cost
            if ce_budget < 0:
                continue

            team_support_options = _filter_support_options_for_team(
                ctx, support_craft_options, used_players
            )
            for craft_cost, craft_choice in craft_combos_with_cost:
                if craft_cost > ce_budget:
                    continue
                for support_craft_id in team_support_options:
                    team = _make_team_config(
                        ctx,
                        req,
                        bp,
                        extras_tuple,
                        mapping,
                        craft_choice,
                        support_id,
                        support_craft_id,
                    )
                    if team is None:
                        continue
                    # 阶段不再由用户手动指定：根据当前礼装组合自动选择最优阶段/灵衣
                    team = calculator.optimize_team_stages(ctx, team)

                    key = tuple(
                        (p.position, p.servant_id, p.craft_id)
                        for p in sorted(team.players, key=lambda x: x.position)
                    ) + ((team.support_position, team.support_servant_id, team.support_craft_id),)
                    if key in seen:
                        continue
                    seen.add(key)

                    metrics = calculator.calculate_team_metrics(ctx, team)
                    evaluated_total += 1
                    total = metrics["totalMultiplier"]

                    if req.strategy == STRATEGY_TARGET_MAX:
                        target_id = req.target_servant_id
                        target_mult = next(
                            (
                                m
                                for p, m in zip(team.players, metrics["multipliers"])
                                if p.servant_id == target_id
                            ),
                            0.0,
                        )
                        score = target_mult * 10000 + total
                    elif req.strategy == STRATEGY_BALANCED:
                        vals = metrics["multipliers"]
                        avg = (sum(vals) / len(vals)) if vals else 0
                        variance = sum((v - avg) ** 2 for v in vals) / len(vals) if vals else 0
                        score = total * 0.85 - variance * 2.0
                    else:
                        score = total

                    # 同一组玩家从者只保留最优礼装/位置组合，避免 Top20 全是同阵容换礼装
                    servant_set = tuple(sorted(p.servant_id for p in team.players))
                    old = best_by_set.get(servant_set)
                    if old is None or score > old["score"]:
                        best_by_set[servant_set] = {
                            "score": score,
                            "team": team,
                        }

            processed += 1
            processed_total += 1
            if progress and (processed % 100 == 0 or processed == 1):
                elapsed = time.time() - start
                report(
                    f"已评估 {evaluated_total:,} 个队伍配置"
                    f"（时间预算 {timeout_seconds:.0f}s，当前 {elapsed:.1f}s）"
                )

    run_with_craft_combos()

    report("排序输出...")
    best_items = sorted(
        best_by_set.values(),
        key=lambda x: x["score"],
        reverse=True,
    )[: req.top_n]
    top = []
    for i, entry in enumerate(best_items, start=1):
        result = calculator.evaluate_team(ctx, entry["team"])
        item = _solution_dict(result, i)
        top.append(item)

    total_candidates = len(best_by_set)
    return {
        "status": "success",
        "totalCandidates": total_candidates,
        "top20": top,
        "_elapsed": round(time.time() - start, 3),
        "_processed": processed_total,
    }
