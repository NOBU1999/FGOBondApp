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
    CLASS_GROUPS,
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
# 用户可手动选择、默认不参与自动搜索的通用礼装；开启参与后依赖 excluded 列表放行。
GENERIC_BOND_CRAFT_IDS = frozenset({-20, -21, -22})


def _repeatable_craft_ids(ctx: DataContext) -> Set[int]:
    """返回引擎中允许重复布置的礼装 ID（内置通用5% + 用户标记可重复的礼装）。"""
    ids = set(REPEATABLE_BOND_IDS)
    for cid, craft in ctx.crafts.items():
        if craft.repeatable:
            ids.add(cid)
    return ids


# ---------------------------------------------------------------------------
# 布局准备
# ---------------------------------------------------------------------------
@dataclass
class PlayerSlot:
    position: str
    fixed_servant_id: Optional[int] = None
    fixed_craft_id: Optional[int] = None
    fixed_craft_type: Optional[str] = None  # bond / other
    is_crown: bool = False
    fixed_second_craft_id: Optional[int] = None
    fixed_second_craft_type: Optional[str] = None  # bond / other


@dataclass
class CraftSlot:
    """玩家位上的一个物理礼装格。index=0 主礼装位，index=1 冠位第二礼装位。"""
    position: str
    index: int = 0
    fixed_craft_id: Optional[int] = None
    fixed_craft_type: Optional[str] = None  # bond / other


@dataclass
class Blueprint:
    support_position: str
    support_servant_id: Optional[int]  # None = auto
    support_craft_id: Optional[int]    # None = auto
    support_second_craft_id: Optional[int] = None
    player_slots: List[PlayerSlot] = field(default_factory=list)
    fixed_player_members: List[PlacedMember] = field(default_factory=list)
    free_servant_positions: List[str] = field(default_factory=list)
    player_craft_slots: List[CraftSlot] = field(default_factory=list)
    free_bond_positions: List[str] = field(default_factory=list)
    fixed_bond_craft_ids: List[int] = field(default_factory=list)
    fixed_other_craft_ids: List[int] = field(default_factory=list)
    fixed_servant_ids: Set[int] = field(default_factory=set)
    crown_positions: Set[str] = field(default_factory=set)


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


def _servant_in_class_group(ctx: DataContext, servant_id: int, class_group: Optional[str]) -> bool:
    if not class_group:
        return True
    allowed = CLASS_GROUPS.get(class_group)
    if allowed is None:
        return True
    info = ctx.servants.get(servant_id)
    return bool(info and info.servant_class in allowed)


def prepare_blueprint(req: CalculationRequest, ctx: DataContext) -> Blueprint:
    """根据请求生成队伍布局。"""
    if req.class_group and req.class_group not in CLASS_GROUPS:
        raise ValueError(f"未知职阶筛选: {req.class_group}")

    box = _box_map(req)
    raw_slots = {
        pos: PlayerSlot(position=pos, is_crown=pos in req.crown_positions)
        for pos in POSITIONS
    }

    # 固定从者
    used_positions: Set[str] = set()
    fixed_servant_ids: Set[int] = set()
    fixed_player_members: List[PlacedMember] = []

    fixed_servants = list(req.fixed_servants)
    unspecified = [fs for fs in fixed_servants if not fs.position]
    specified = [fs for fs in fixed_servants if fs.position]

    def check_servant_class(sid: int) -> None:
        if not _servant_in_class_group(ctx, sid, req.class_group):
            name = (ctx.servants.get(sid).name if ctx.servants.get(sid) else sid)
            raise ValueError(f"固定从者 {name} 不属于当前职阶筛选，请先调整职阶或移除该从者")

    for fs in specified:
        if fs.servant_id in fixed_servant_ids:
            raise ValueError(f"固定从者重复: {fs.servant_id}")
        if fs.position not in POSITIONS:
            raise ValueError(f"未知位置: {fs.position}")
        if fs.position in used_positions:
            raise ValueError(f"固定从者位置冲突: {fs.position}")
        check_servant_class(fs.servant_id)
        used_positions.add(fs.position)
        fixed_servant_ids.add(fs.servant_id)
        raw_slots[fs.position].fixed_servant_id = fs.servant_id

    for pos in POSITIONS:
        if pos not in used_positions and unspecified:
            fs = unspecified.pop(0)
            if fs.servant_id in fixed_servant_ids:
                raise ValueError(f"固定从者重复: {fs.servant_id}")
            check_servant_class(fs.servant_id)
            used_positions.add(pos)
            fixed_servant_ids.add(fs.servant_id)
            raw_slots[pos].fixed_servant_id = fs.servant_id

    if unspecified:
        raise ValueError("固定从者位置不足")

    # 固定礼装（主位 + 冠位第二礼装位）
    used_craft_slots: Set[Tuple[str, int]] = set()
    fixed_bond_ids: List[int] = []
    fixed_other_ids: List[int] = []
    for fc in req.fixed_crafts:
        slot_no = fc.slot
        if fc.position not in POSITIONS:
            raise ValueError(f"未知礼装位置: {fc.position}")
        if slot_no not in (0, 1):
            raise ValueError(f"未知礼装槽位: {slot_no}")
        if slot_no == 1 and not raw_slots[fc.position].is_crown:
            raise ValueError(f"位置 {fc.position} 未设为冠位从者，不能有第二礼装")
        craft = ctx.crafts.get(fc.craft_id)
        if craft is None:
            raise ValueError(f"礼装不存在: {fc.craft_id}")
        # 英灵逢魔系列全局排除：即使是旧预设固定了也忽略，让该位置回退为自由位
        if fc.type == "bond" and _is_ouma_craft(ctx, fc.craft_id):
            continue
        key = (fc.position, slot_no)
        if key in used_craft_slots:
            raise ValueError(f"固定礼装位置冲突: {fc.position} 槽位 {slot_no}")
        used_craft_slots.add(key)
        if slot_no == 0:
            raw_slots[fc.position].fixed_craft_id = fc.craft_id
            raw_slots[fc.position].fixed_craft_type = fc.type
        else:
            raw_slots[fc.position].fixed_second_craft_id = fc.craft_id
            raw_slots[fc.position].fixed_second_craft_type = fc.type
        if fc.type == "bond":
            fixed_bond_ids.append(fc.craft_id)
        else:
            fixed_other_ids.append(fc.craft_id)

    manual_support = SupportConfig(
        servant_id=req.support.servant_id if req.support else None,
        craft_id=req.support.craft_id if req.support else None,
        second_craft_id=req.support.second_craft_id if req.support else None,
        position=req.support.position if req.support else None,
    )
    # 英灵逢魔系列全局排除：助战固定了也按“未指定礼装”处理
    if manual_support.craft_id is not None and _is_ouma_craft(ctx, manual_support.craft_id):
        manual_support.craft_id = None
    if manual_support.second_craft_id is not None and _is_ouma_craft(ctx, manual_support.second_craft_id):
        manual_support.second_craft_id = None
    if manual_support.servant_id is not None and not _servant_in_class_group(
        ctx, manual_support.servant_id, req.class_group
    ):
        name = ctx.servants.get(manual_support.servant_id)
        raise ValueError(f"助战从者 {name.name if name else manual_support.servant_id} 不属于当前职阶筛选，请先调整职阶")

    player_slots_all = [s for s in raw_slots.values()]
    support_position = _choose_support_position(req, player_slots_all)
    support_slot = raw_slots[support_position]
    if support_slot.fixed_servant_id is not None:
        raise ValueError(f"助战位与固定从者冲突: {support_position}")
    if support_slot.fixed_craft_id is not None or support_slot.fixed_second_craft_id is not None:
        raise ValueError(f"助战位与固定礼装冲突: {support_position}")

    # 玩家位 = 除 support_position 外的 5 个位置
    player_slots = [raw_slots[pos] for pos in POSITIONS if pos != support_position]

    # 组装 fixed player members（含主礼装/第二礼装）
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
                second_craft_id=slot.fixed_second_craft_id,
                is_crown=slot.is_crown,
                fixed=True,
                stage_locked=user_stage is not None,
            )
        )

    free_servant_positions = [
        s.position for s in player_slots if s.fixed_servant_id is None
    ]

    # 玩家礼装物理槽。优先把自由礼装槽放在冠位槽前面（计算时优先填充冠位）。
    player_craft_slots: List[CraftSlot] = []
    for slot in sorted(player_slots, key=lambda s: (not s.is_crown, POSITIONS.index(s.position))):
        player_craft_slots.append(CraftSlot(position=slot.position, index=0,
                                             fixed_craft_id=slot.fixed_craft_id,
                                             fixed_craft_type=slot.fixed_craft_type))
        if slot.is_crown:
            player_craft_slots.append(CraftSlot(position=slot.position, index=1,
                                                 fixed_craft_id=slot.fixed_second_craft_id,
                                                 fixed_craft_type=slot.fixed_second_craft_type))
    free_bond_positions = [
        cs.position for cs in player_craft_slots if cs.fixed_craft_id is None
    ]

    bp = Blueprint(
        support_position=support_position,
        support_servant_id=manual_support.servant_id,
        support_craft_id=manual_support.craft_id,
        support_second_craft_id=manual_support.second_craft_id,
        player_slots=player_slots,
        fixed_player_members=fixed_player_members,
        free_servant_positions=free_servant_positions,
        player_craft_slots=player_craft_slots,
        free_bond_positions=free_bond_positions,
        fixed_bond_craft_ids=fixed_bond_ids,
        fixed_other_craft_ids=fixed_other_ids,
        fixed_servant_ids=fixed_servant_ids,
        crown_positions=set(req.crown_positions),
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


def _sample_servant_combinations(
    candidate_ids: Sequence[int],
    choose_count: int,
    limit: int,
) -> List[Tuple[int, ...]]:
    """等距抽样从者组合，避免只搜索候选池前部的组合。"""
    combos = list(_generate_servant_combinations(candidate_ids, choose_count))
    if len(combos) <= limit:
        return combos
    step = len(combos) / max(1, limit)
    return [combos[int(i * step)] for i in range(limit)]


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
        and not craft.is_custom
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
    """英灵逢魔系列：用户明确要求不进入推荐/自动池，也不参与启发式评分。

    合成“通用英灵逢魔”（-21）不算被全局排除的个别英灵逢魔礼装。
    """
    craft = ctx.crafts.get(craft_id)
    if craft is None:
        return False
    if craft_id in GENERIC_BOND_CRAFT_IDS:
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
    """按等待时间动态决定从者候选组合上限，等待越久搜索越广。

    时间预算已经提高（fast≈20s / balanced≈45s / high≈120s），
    这里也相应放宽到最多 4000 个从者组合。
    """
    return max(200, min(4000, int(_time_budget_seconds(req) * 200)))


def _default_craft_combo_limit(req: CalculationRequest) -> int:
    """大 Box 下控制单组从者要尝试的礼装组合数量，避免组合爆炸。

    需要保留足够多的“少装一两张礼装”的组合：当 Cost 不够放满全部礼装时，
    如果只截断在高数量组合，容易漏掉末尾的特性礼装（如杀阶 20% 礼装）。
    """
    dynamic = int(_time_budget_seconds(req) * 200)
    return max(4000, min(12000, dynamic))



def _craft_combo_actual_cost(
    ctx: DataContext,
    combo: Sequence[int],
    zero_cost_slots: Optional[Sequence[bool]] = None,
) -> int:
    """计算一组自由礼装放在最优物理槽位时的真实 Cost。

    第二礼装位（zero_cost_slots 中 True）不消耗 Cost，但仍然占一个物理槽。
    因此给定 N 张礼装时，可以把其中最多 min(N, zero_slot_count) 张最贵的
    礼装放到第二礼装位，其余 Cost 照常计入。该函数与 _make_team_config 中
    “先选第二礼装位、再按 Cost 降序填装”的分配方式保持一致。
    """
    if not combo:
        return 0
    zero_count = sum(1 for z in (zero_cost_slots or []) if z)
    costs = sorted(ctx.crafts[cid].cost for cid in combo)
    discount = sum(costs[-min(len(costs), zero_count):]) if zero_count > 0 else 0
    return sum(costs) - discount


def _generate_craft_combinations_with_cost(
    ctx: DataContext,
    candidate_craft_ids: Sequence[int],
    free_slots_count: int,
    max_total: int = 200000,
    zero_cost_slots: Optional[Sequence[bool]] = None,
) -> List[Tuple[int, Tuple[int, ...]]]:
    """生成 0..free_slots_count 的礼装组合，并带上礼装总Cost。

    返回 [(craftCost, craftIds), ...]，排序为“礼装数量多优先、Cost小优先”。
    zero_cost_slots 与 free_bond_positions 对齐，True 表示该自由礼装格是冠位第二礼装位，
    即使放了礼装也不计 Cost（仍参与加成）。
    """
    if free_slots_count <= 0:
        return [(0, ())]
    zero = list(zero_cost_slots or [])
    result: List[Tuple[int, Tuple[int, ...]]] = []
    seen: set = set()

    def combo_cost(c: Tuple[int, ...]) -> int:
        # 统一使用“最优槽位分配”口径：只要有空闲第二礼装位，就减免最贵的若干张。
        return _craft_combo_actual_cost(ctx, c, zero)

    candidate_ids = list(candidate_craft_ids)
    cheapest_ids = sorted(
        candidate_ids,
        key=lambda cid: ctx.crafts[cid].cost if cid in ctx.crafts else 0,
    )
    max_size = free_slots_count

    # 多样性种子：确保每个候选礼装都在“少装 1~N 张”的组合里至少出现一次。
    # 这样即使后续被 max_total 截断，也不会因为礼装排在候选池末尾而完全漏掉。
    for size in range(1, max_size + 1):
        for target in candidate_ids:
            if len(result) >= max_total:
                break
            parts = [target]
            for cid in cheapest_ids:
                if len(parts) >= size:
                    break
                if cid != target:
                    parts.append(cid)
            # 候选池不足 size 时，只有可重复通用5%能补足；否则该种子不合法，跳过
            if len(parts) < size and -10 not in candidate_ids:
                continue
            while len(parts) < size:
                parts.append(-10)
            c = tuple(sorted(parts))
            cost = combo_cost(c)
            entry = (cost, c)
            if entry not in seen:
                result.append(entry)
                seen.add(entry)

    # 再按“礼装多优先”生成常规组合；种子已经保证了每个礼装在低数量组合里也有代表。
    repeatable_ids = _repeatable_craft_ids(ctx)
    stopped_size: Optional[int] = None
    for size in range(max_size, -1, -1):
        for c in _generate_multiset_combinations(
            candidate_ids, size, repeatable_ids
        ):
            cost = combo_cost(c)
            entry = (cost, tuple(c))
            if entry not in seen:
                result.append(entry)
                seen.add(entry)
            if len(result) >= max_total:
                stopped_size = size
                break
        if stopped_size is not None:
            break

    # 确保有空礼装兜底
    if (0, ()) not in seen:
        result.append((0, ()))
        seen.add((0, ()))

    # 按预期收益排序：礼装越多通常收益越高；同数量下低Cost优先
    result.sort(key=lambda x: (-len(x[1]), x[0]))
    return result


def _sample_craft_combos(
    combos: Sequence[Tuple[int, Tuple[int, ...]]],
    limit: int,
) -> List[Tuple[int, Tuple[int, ...]]]:
    """从完整礼装组合中等距抽样，用于第一轮快速覆盖更多从者组合。

    完整组合仍会在第二轮对 Top 从者组合精算，因此这里抽样不会丢失最终精算。
    """
    if not combos:
        return []
    if len(combos) <= limit:
        return list(combos)
    step = len(combos) / max(1, limit)
    sampled = [combos[int(i * step)] for i in range(limit)]
    # 确保空礼装组合保留，避免无礼装兜底缺失
    if (0, ()) not in sampled:
        sampled[-1] = (0, ())
    return sampled


def _greedy_mapping(
    ctx: DataContext,
    box: Dict[int, BoxServant],
    extras: Sequence[int],
    free_positions: Sequence[str],
) -> Dict[str, int]:
    """启发式分配：潜力高的从者放前排，减少位置排列爆炸。

    同时避免“自身收益为 0 的满绊从者”占用前排名额：
    这类从者放在前排不会吃到 20% 前排加成，等于浪费前排名额，
    因此优先把它们安排到后排；只有在后排不足时才放入前排。
    """
    if not extras:
        return {}
    trait_ids = _trait_craft_ids(ctx)
    gainers = []
    no_gain = []
    for sid in extras:
        bs = box.get(sid)
        if bs is not None and not bs.count_personal_bond:
            no_gain.append(sid)
        else:
            gainers.append(sid)
    gainers.sort(
        key=lambda sid: _servant_heuristic(ctx, box[sid], trait_ids),
        reverse=True,
    )
    no_gain.sort(
        key=lambda sid: _servant_heuristic(ctx, box[sid], trait_ids),
        reverse=True,
    )

    front_positions = [p for p in free_positions if p in FRONT_POSITIONS]
    back_positions = [p for p in free_positions if p not in FRONT_POSITIONS]
    mapping = {}

    # 先处理后排：优先放“自身收益为 0”的满绊从者；
    # 如果后排还有空位，用剩余收益里“较低”的从者补后排。
    for pos in back_positions:
        if no_gain:
            mapping[pos] = no_gain.pop(0)
        elif gainers:
            mapping[pos] = gainers.pop()  # gainers 已降序，pop() 取最低者放后排

    # 再处理前排：剩余收益从者里“较高”的放前排；万不得已才放无收益从者。
    for pos in front_positions:
        if gainers:
            mapping[pos] = gainers.pop(0)
        elif no_gain:
            mapping[pos] = no_gain.pop(0)
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
    support_second_craft_id: Optional[int] = None,
) -> Optional[TeamConfig]:
    box = _box_map(req)

    # 必须复制固定成员，不能直接复用 bp.fixed_player_members 里的对象
    players_by_pos: Dict[str, PlacedMember] = {}
    for p in bp.fixed_player_members:
        players_by_pos[p.position] = PlacedMember(
            position=p.position,
            servant_id=p.servant_id,
            stage=p.stage,
            personal_bonus=p.personal_bonus,
            aura_bonus=p.aura_bonus,
            max_bond=p.max_bond,
            bond_switch1=p.bond_switch1,
            bond_switch2=p.bond_switch2,
            craft_id=p.craft_id,
            second_craft_id=p.second_craft_id,
            is_crown=p.is_crown,
            fixed=p.fixed,
            stage_locked=p.stage_locked,
        )

    for slot in bp.player_slots:
        if slot.fixed_servant_id is not None:
            continue
        sid = mapping.get(slot.position)
        if sid is None:
            continue
        bs = box.get(sid)
        if bs is None:
            return None
        players_by_pos[slot.position] = PlacedMember(
            position=slot.position,
            servant_id=sid,
            stage=bs.stage,
            personal_bonus=bs.personal_bonus,
            aura_bonus=bs.aura_bonus,
            max_bond=bs.max_bond,
            bond_switch1=bs.bond_switch1,
            bond_switch2=bs.bond_switch2,
            craft_id=None,
            second_craft_id=None,
            is_crown=slot.is_crown,
            fixed=False,
        )

    if len(players_by_pos) != 5:
        return None

    # 先填手动固定礼装，再把自动生成的礼装填入自由礼装槽。
    for cs in bp.player_craft_slots:
        if cs.fixed_craft_id is None:
            continue
        player = players_by_pos.get(cs.position)
        if player is None:
            continue
        if cs.index == 0:
            player.craft_id = cs.fixed_craft_id
        else:
            player.second_craft_id = cs.fixed_craft_id

    # 自由槽不一定从物理列表头部取；为了 Cost 最优，总是先选冠位第二礼装位
    # （Cost 0 但仍占槽），再选主礼装位，然后按礼装 Cost 降序填入。
    free_slots = [cs for cs in bp.player_craft_slots if cs.fixed_craft_id is None]
    ordered_free_slots = sorted(
        free_slots,
        key=lambda cs: (0 if cs.index == 1 else 1, POSITIONS.index(cs.position)),
    )
    used_free_slots = ordered_free_slots[:len(craft_choice)]
    ordered_crafts = sorted(
        craft_choice,
        key=lambda cid: ctx.crafts[cid].cost if cid in ctx.crafts else 0,
        reverse=True,
    )
    for cs, cid in zip(ordered_free_slots, ordered_crafts):
        player = players_by_pos.get(cs.position)
        if player is None:
            continue
        if cs.index == 0:
            player.craft_id = cid
        else:
            player.second_craft_id = cid

    return TeamConfig(
        players=list(players_by_pos.values()),
        support_position=bp.support_position,
        support_servant_id=support_servant_id,
        support_craft_id=support_craft_id,
        support_second_craft_id=support_second_craft_id,
        crown_positions=bp.crown_positions,
        base_bond=req.base_bond,
        activity_bonus=req.activity_bonus,
    )


def _fill_remaining_craft_slots(
    ctx: DataContext,
    req: CalculationRequest,
    bp: Blueprint,
    team: TeamConfig,
    candidate_craft_ids: Sequence[int],
) -> TeamConfig:
    """把自由礼装位中仍为空、且 Cost 允许的槽位用可用礼装补满。

    粗搜/DP 只评估了少量礼装组合，可能出现“还有空槽+剩余 Cost 却空着”的队伍。
    这个函数在最终计分前做一次保守贪心补满：优先选可重复/低 Cost 的正收益礼装，
    保证展示出来的队伍尽量用满可用 Cost 与槽位。
    """
    player_by_pos = {p.position: p for p in team.players}
    used_ids: Dict[int, int] = {}
    for p in team.players:
        for cid in (p.craft_id, p.second_craft_id):
            if cid is None:
                continue
            used_ids[cid] = used_ids.get(cid, 0) + 1

    servant_cost = sum(
        ctx.servants[p.servant_id].cost for p in team.players if p.servant_id in ctx.servants
    )
    main_cost = sum(
        ctx.crafts[p.craft_id].cost for p in team.players
        if p.craft_id is not None and p.craft_id in ctx.crafts
    )
    remaining = req.cost_limit - servant_cost - main_cost
    repeatable_ids = _repeatable_craft_ids(ctx)

    # 第二礼装位优先补（Cost 0，不会挤占主 Cost），再补主礼装位。
    free_slots = [
        cs for cs in bp.player_craft_slots
        if cs.fixed_craft_id is None
    ]
    free_slots.sort(key=lambda cs: (0 if cs.index == 1 else 1, POSITIONS.index(cs.position)))
    for cs in free_slots:
        player = player_by_pos.get(cs.position)
        if player is None:
            continue
        current = player.second_craft_id if cs.index == 1 else player.craft_id
        if current is not None:
            continue
        best_cid = None
        best_rank = None
        for cid in candidate_craft_ids:
            craft = ctx.crafts.get(cid)
            if craft is None or not craft.is_bond_ce:
                continue
            if used_ids.get(cid, 0) > 0 and cid not in repeatable_ids:
                continue
            if cs.index == 0:
                craft_cost = craft.cost
                if craft_cost > remaining:
                    continue
            # 只补“当前队伍真的能吃到收益”的礼装；
            # 不要为了用满 Cost/槽位而补一张特性完全触发不了的礼装。
            if not _free_craft_benefits_team(ctx, team, craft):
                continue
            # 简单价值排序：百分比 + 固定值折算，重复可用时优先选通用5%或更高百分比。
            value = craft.bonus_value + craft.flat_bonus / 10000.0
            if best_rank is None or value > best_rank:
                best_rank = value
                best_cid = cid
        if best_cid is None:
            continue
        craft = ctx.crafts[best_cid]
        if cs.index == 1:
            player.second_craft_id = best_cid
        else:
            player.craft_id = best_cid
            remaining -= craft.cost
        used_ids[best_cid] = used_ids.get(best_cid, 0) + 1
    return team


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
        if not _servant_in_class_group(ctx, sid, req.class_group):
            return None
        return sid

    # 自动助战：按职阶筛选约束选择展示用从者。
    candidates = [
        sid for sid in ctx.servants
        if sid not in req.excluded_servant_ids
        and _servant_in_class_group(ctx, sid, req.class_group)
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


def _free_craft_benefits_team(
    ctx: DataContext,
    team: Any,
    craft: Any,
) -> bool:
    """自由礼装位自动填入时，判断这张礼装是否真的能对当前队伍产生收益。

    不检查用户手动固定的礼装；只用于自动搜索/自动补满。
    - 通用/固定数值礼装：只要队伍里有计入收益的成员即可；
    - 特性礼装：至少有一位“计入收益的成员”能在其可选/已锁定阶段下满足条件。
    避免低排名队伍为了“填满空位”而随机补一张完全触发不了的特性礼装。
    """
    if craft is None or not craft.is_bond_ce:
        return False
    if float(craft.support_bonus or 0.0) > 0:
        return False
    if not (float(craft.bonus_value or 0.0) > 0 or float(craft.flat_bonus or 0.0) > 0):
        return False

    for p in (team.players or []):
        if p.max_bond and not p.bond_switch2:
            continue  # 该成员个人收益为 0，放特性/数值礼装不会产生总收益
        if craft.bonus_type in ("universal", None):
            return True
        if craft.bonus_type == "trait":
            if p.stage_locked:
                traits = ctx.servant_traits(p.servant_id, p.stage)
                if any(
                    calculator.match_trait_group(traits, g)
                    for g in (craft.trigger_traits or [])
                ):
                    return True
            elif _servant_can_match_craft_any_stage(ctx, p.servant_id, craft):
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
        if craft.flat_bonus > 0:
            # 自定义固定数值加成必须参与助战候选
            result.append(cid)
            continue
        if cid in GENERIC_BOND_CRAFT_IDS:
            # 通用礼装：用户右键开启后进入自动搜索
            result.append(cid)
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


def _auto_support_craft_options(ctx: DataContext, req: CalculationRequest) -> List[int]:
    """生成助战位“自动可选”礼装列表，不受手动主礼装影响。

    把午茶、普通通用、特性礼装都作为候选参与搜索，由实际收益决定最优助战礼装
    （如全队兽科时 NFF 可能优于午茶）。
    """
    options: List[int] = []
    for cid, craft in ctx.crafts.items():
        if not craft.is_bond_ce:
            continue
        # 助战是“借别人”的：手动排除不影响助战自动池；
        # 只有服务器未实装/通用礼装未开启参与等“客观不可用”才过滤。
        if cid in req.support_excluded_craft_ids:
            continue
        if _is_event_limited_craft(ctx, cid):
            continue
        if _is_ouma_craft(ctx, cid):
            continue
        if _is_merged_generic_universal5(ctx, cid):
            continue
        if not (craft.bonus_value > 0.025 or craft.support_bonus > 0.025 or craft.flat_bonus > 0 or cid in GENERIC_BOND_CRAFT_IDS):
            continue
        options.append(cid)
    # 让高价值候选排在前面，便于后续截断/稳定
    options.sort(key=lambda cid: (
        ctx.crafts[cid].bonus_type != "universal",
        -ctx.crafts[cid].bonus_value,
        -ctx.crafts[cid].support_bonus,
    ))
    return options[: req.craft_pool_size + 1]


def _support_craft_options(ctx: DataContext, req: CalculationRequest) -> List[int]:
    """生成助战主礼装位候选。

    - 用户手动指定助战礼装（包括显式选午茶或无礼装 0）时，只使用该礼装；
    - 未指定时，使用自动候选池。
    """
    if req.support and req.support.craft_id is not None:
        cid = req.support.craft_id
        return [cid] if cid in ctx.crafts else []
    return _auto_support_craft_options(ctx, req)


def _solution_dict(result: Dict[str, Any], rank: int) -> Dict[str, Any]:
    return {
        "rank": rank,
        "totalMultiplier": result["totalMultiplier"],
        "costUsed": result["costUsed"],
        "baseBond": result.get("baseBond", 0),
        "totalBondPoints": result.get("totalBondPoints", 0),
        "team": result["team"],
        "maxBondStats": result["maxBondStats"],
        "traitCoverage": result["traitCoverage"],
    }


def _matches_any_trait_craft(ctx: DataContext, servant_id: int, craft_ids: Sequence[int]) -> bool:
    for cid in craft_ids:
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        if _servant_can_match_craft_any_stage(ctx, servant_id, craft):
            return True
    return False


def _multi_trait_count(ctx: DataContext, servant_id: int, trait_ids: Sequence[int]) -> int:
    return sum(
        1
        for cid in trait_ids
        if _servant_can_match_craft_any_stage(ctx, servant_id, ctx.crafts[cid])
    )


# ---------------------------------------------------------------------------
# 松弛评分 / DP 礼装组合 / 从者组合上界剪枝
# ---------------------------------------------------------------------------
# 说明：
# - 这里的“松弛”指：单张礼装按“该从者在某个阶段/灵衣下能吃到”来估值，
#   不处理多张特性礼装在同一个阶段上互斥的精确联合优化。它只会高估真实收益，
#   因此可以安全用于上界剪枝；DP 产出的组合仍会在精算阶段用 optimize_team_stages
#   做精确评估。
# - 冠位第二礼装位在 DP 中按“占一个槽、但可减免一张最贵礼装的 Cost”处理。
@dataclass
class _RelaxedPlayer:
    position: str
    servant_id: int
    front_factor: float
    personal_bonus: float
    aura_bonus: float
    counted: bool          # 自身是否计入牵绊收益（满绊关开关二为 False）
    counts_max_bond: bool  # 是否计入全队 25% 满绊人数


def _relaxed_players_from_mapping(
    ctx: DataContext,
    req: CalculationRequest,
    bp: Blueprint,
    box: Dict[int, BoxServant],
    mapping: Dict[str, int],
) -> List[_RelaxedPlayer]:
    """按“固定从者 + 本次抽样映射”还原 5 个玩家位，生成松弛评分用条目。"""
    players: List[_RelaxedPlayer] = []
    support_in_front = bool(bp.support_position in FRONT_POSITIONS)
    for slot in bp.player_slots:
        sid = slot.fixed_servant_id
        if sid is None:
            sid = mapping.get(slot.position)
        if sid is None:
            continue
        bs = box.get(sid)
        if bs is None:
            continue
        players.append(
            _RelaxedPlayer(
                position=slot.position,
                servant_id=sid,
                front_factor=1.0 + calculator.frontline_bonus(slot.position, support_in_front),
                personal_bonus=bs.personal_bonus,
                aura_bonus=bs.aura_bonus,
                counted=bs.count_personal_bond,
                counts_max_bond=bs.count_in_team_bonus,
            )
        )
    return players


def _relaxed_team_constants(players: Sequence[_RelaxedPlayer]) -> Tuple[int, float]:
    """返回 (满绊开关一人数, 全队 aura 之和)。"""
    max_bond_count = sum(1 for p in players if p.counts_max_bond)
    aura_total = sum(float(p.aura_bonus or 0.0) for p in players)
    return max_bond_count, aura_total


def _relaxed_percent_weight(req: CalculationRequest) -> float:
    """百分比加成折算成最终分数的权重。

    有 base_bond 时走“点数 = 倍率 * base_bond”；没有 base_bond 且通常没有
    自定义固定值时，搜索排序直接使用总倍率，因此权重为 1。
    """
    return req.base_bond if req.base_bond else 1.0


def _relaxed_base_score(
    ctx: DataContext,
    req: CalculationRequest,
    players: Sequence[_RelaxedPlayer],
) -> float:
    """没有任何自由礼装/助战礼装时的松弛总分基线。"""
    max_bond_count, aura_total = _relaxed_team_constants(players)
    activity = req.activity_bonus or 0.0
    weight = _relaxed_percent_weight(req)
    total = 0.0
    for p in players:
        if not p.counted:
            continue
        inner = (
            1.0
            + max_bond_count * 0.25
            + activity
            + aura_total
            + p.personal_bonus
        )
        total += p.front_factor * inner
    return weight * total


def _relaxed_craft_score(
    ctx: DataContext,
    req: CalculationRequest,
    craft: Any,
    players: Sequence[_RelaxedPlayer],
) -> float:
    """单张玩家位礼装的松弛总分贡献。

    特性礼装按“该从者任一阶段/灵衣可满足条件”计入，可能高估，但保证不低估。
    """
    if craft is None:
        return 0.0
    weight = _relaxed_percent_weight(req)
    percent_score = 0.0
    flat_score = 0.0
    for p in players:
        if not p.counted:
            continue
        can_match = craft.bonus_type == "universal"
        if craft.bonus_type == "trait":
            can_match = _servant_can_match_craft_any_stage(ctx, p.servant_id, craft)
        if craft.bonus_type == "support_only" and craft.bonus_value > 0:
            can_match = True
        if not can_match:
            continue
        percent_score += float(craft.bonus_value) * p.front_factor
        flat_score += float(craft.flat_bonus or 0.0)
    return weight * percent_score + flat_score


def _make_craft_score_map(
    ctx: DataContext,
    req: CalculationRequest,
    players: Sequence[_RelaxedPlayer],
    candidate_craft_ids: Sequence[int],
) -> Dict[int, float]:
    """为每个候选礼装计算松弛分数，供 DP 使用。"""
    return {
        cid: _relaxed_craft_score(ctx, req, ctx.crafts.get(cid), players)
        for cid in candidate_craft_ids
    }


def _relaxed_support_craft_score(
    ctx: DataContext,
    req: CalculationRequest,
    craft: Any,
    players: Sequence[_RelaxedPlayer],
) -> float:
    """单张助战礼装的松弛总分贡献。

    助战专属加成（support_bonus>0）作为全队加算项；普通助战礼装
    （support_bonus<=0）则与玩家礼装一样进入 universal/trait/flat。
    """
    if craft is None:
        return 0.0
    if float(craft.support_bonus or 0.0) > 0:
        weight = _relaxed_percent_weight(req)
        return weight * sum(
            p.front_factor * float(craft.support_bonus)
            for p in players
            if p.counted
        )
    if craft.is_bond_ce and float(craft.support_bonus or 0.0) <= 0:
        return _relaxed_craft_score(ctx, req, craft, players)
    return 0.0


def _support_max_relaxed_add(
    ctx: DataContext,
    req: CalculationRequest,
    support_top_options: Sequence[int],
    support_second_options: Sequence[int],
    players: Sequence[_RelaxedPlayer],
    repeatable_ids: Set[int],
) -> float:
    """助战主位/第二礼装位能提供的最大松弛加分（不参与玩家礼装 DP）。"""
    main_scores: List[Tuple[float, int]] = []
    for cid in support_top_options:
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        main_scores.append((_relaxed_support_craft_score(ctx, req, craft, players), cid))
    second_scores: List[Tuple[float, int]] = []
    for cid in support_second_options:
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        second_scores.append((_relaxed_support_craft_score(ctx, req, craft, players), cid))

    best = 0.0
    for score, _ in main_scores:
        if score > best:
            best = score
    for ms, mid in main_scores:
        for ss, sid in second_scores:
            if mid == sid and mid not in repeatable_ids and mid > 0:
                # 同一张不可重复礼装不能同时放助战主位和第二礼装位。
                continue
            total = ms + ss
            if total > best:
                best = total
    return best


def _combo_relaxed_score(
    combo: Sequence[int],
    craft_scores: Dict[int, float],
) -> float:
    """一组礼装（按多重集合）的松弛总分。"""
    return sum(craft_scores.get(cid, 0.0) for cid in combo)


def _dp_top_craft_combinations(
    ctx: DataContext,
    candidate_craft_ids: Sequence[int],
    free_slots_count: int,
    cost_budget: int,
    repeatable_ids: Set[int],
    zero_cost_slots: Optional[Sequence[bool]],
    craft_scores: Dict[int, float],
    top_k: int = 10,
) -> List[Tuple[int, Tuple[int, ...]]]:
    """固定从者阵容下的礼装 DP：返回少量有希望的 (Cost, craftId组合)。

    状态为 (已用槽数, 未减免前的原始 Cost)，每个状态只保留 Top K 个组合。
    由于槽数 <=6、礼装 Cost 很小，这种有界背包在搜索热路径上足够快。

    - 非 repeatable 礼装最多出现 1 次；
    - repeatable 礼装（含 -10 通用5%）可出现到占满所有自由槽；
    - 第二礼装位不参与这里的 raw cost，但最后用 _craft_combo_actual_cost
      做真实 Cost 过滤，保证 Cost 预算口径一致。
    """
    candidates = [cid for cid in candidate_craft_ids if cid in craft_scores]
    if free_slots_count <= 0 or not candidates:
        return [(0, ())]

    zero_cost_slots = list(zero_cost_slots or [])
    zero_count = sum(1 for z in zero_cost_slots if z)
    max_craft_cost = max((ctx.crafts[cid].cost for cid in candidates), default=0)
    # 原始 Cost 超过 “预算 + 最多可减免额” 的组合不可能真实可行。
    raw_cap = min(
        free_slots_count * max_craft_cost,
        max(0, cost_budget) + zero_count * max_craft_cost,
    )

    # dp[(used, raw_cost)] -> [(score, combo)]，按 score 降序截断 top_k。
    dp: Dict[Tuple[int, int], List[Tuple[float, Tuple[int, ...]]]] = {
        (0, 0): [(0.0, ())],
    }

    def _add_entry(
        state: Tuple[int, int],
        score: float,
        combo: Tuple[int, ...],
    ) -> None:
        arr = dp.setdefault(state, [])
        # 同一 (used, raw_cost) 下若 score 更低，不可能在后续非负加成组合中反超，
        # 因此只保留 Top K 即可。
        arr.append((score, combo))
        arr.sort(key=lambda x: -x[0])
        if len(arr) > top_k:
            del arr[top_k:]

    for cid in candidates:
        craft_cost = ctx.crafts[cid].cost
        single_value = craft_scores[cid]
        max_copies = free_slots_count if cid in repeatable_ids else 1
        if single_value <= 0:
            # 零收益礼装即使 Cost 很低也不能提升结果；
            # 展开只会产生“完全触发不了/没有实际加成”的占位礼装组合。
            continue
        old_items = list(dp.items())
        for (used, raw_cost), entries in old_items:
            for base_score, base_combo in entries:
                # 同一种礼装一次性加 copies 张，避免同轮内重复使用该类型。
                for copies in range(1, max_copies + 1):
                    new_used = used + copies
                    if new_used > free_slots_count:
                        break
                    new_raw = raw_cost + craft_cost * copies
                    if new_raw > raw_cap:
                        break
                    _add_entry(
                        (new_used, new_raw),
                        base_score + single_value * copies,
                        base_combo + (cid,) * copies,
                    )

    # 汇总所有真实 Cost <= 预算的组合，按松弛分排序取 Top K。
    results: List[Tuple[int, Tuple[int, ...]]] = []
    for (used, _raw_cost), entries in dp.items():
        if used > free_slots_count:
            continue
        for score, combo in entries:
            # 防御性校验：非可重复礼装不允许在同一组合里出现多次。
            counts: Dict[int, int] = {}
            ok = True
            for cid in combo:
                counts[cid] = counts.get(cid, 0) + 1
                if counts[cid] > 1 and cid not in repeatable_ids:
                    ok = False
                    break
            if not ok:
                continue
            real_cost = _craft_combo_actual_cost(ctx, combo, zero_cost_slots)
            if real_cost <= cost_budget:
                results.append((score, real_cost, combo))
    results.sort(key=lambda x: (-x[0], x[1]))
    return [(cost, combo) for _score, cost, combo in results[:top_k]]


def _prepare_dp_craft_combos_for_team(
    ctx: DataContext,
    req: CalculationRequest,
    bp: Blueprint,
    box: Dict[int, BoxServant],
    mapping: Dict[str, int],
    candidate_craft_ids: Sequence[int],
    cost_budget: int,
    zero_cost_slots: Optional[Sequence[bool]],
    top_k: int = 10,
) -> Tuple[List[_RelaxedPlayer], Dict[int, float], List[Tuple[int, Tuple[int, ...]]]]:
    """生成某套从者阵容的松弛玩家信息、礼装分数与 DP 组合。"""
    players = _relaxed_players_from_mapping(ctx, req, bp, box, mapping)
    craft_scores = _make_craft_score_map(ctx, req, players, candidate_craft_ids)
    dp_combos = _dp_top_craft_combinations(
        ctx,
        candidate_craft_ids,
        len(bp.free_bond_positions),
        cost_budget,
        _repeatable_craft_ids(ctx),
        zero_cost_slots,
        craft_scores,
        top_k=top_k,
    )
    return players, craft_scores, dp_combos


def _relaxed_score_upper_bound(
    ctx: DataContext,
    req: CalculationRequest,
    players: Sequence[_RelaxedPlayer],
    craft_scores: Dict[int, float],
    dp_combos: Sequence[Tuple[int, Tuple[int, ...]]],
    support_top_options: Sequence[int],
    support_second_options: Sequence[int],
    candidate_craft_ids: Optional[Sequence[int]] = None,
    free_slots_count: int = 0,
    cost_budget: int = 0,
    zero_cost_slots: Optional[Sequence[bool]] = None,
    fixed_bond_craft_ids: Optional[Sequence[int]] = None,
) -> float:
    """计算一套从者阵容的保守总分上界（对应 _score_from_metrics 的口径）。

    - 玩家礼装取 DP 中松弛分最高的组合；
    - 助战礼装单独取最大可能加分；
    - 总上界 = 无礼装基线 + 玩家礼装上界 + 助战礼装上界。
    由于松弛口径只可能高估，因此可作为“是否可能超过当前 best”的剪枝判据。
    """
    repeatable_ids = _repeatable_craft_ids(ctx)
    baseline = _relaxed_base_score(ctx, req, players)
    # 固定礼装已经占用了槽位，效果恒定存在；上界必须包含它们，否则会低估可达到分数。
    for cid in (fixed_bond_craft_ids or []):
        baseline += _relaxed_craft_score(ctx, req, ctx.crafts.get(cid), players)
    best_craft_score = max(
        (_combo_relaxed_score(combo, craft_scores) for _, combo in dp_combos),
        default=0.0,
    )
    support_add = _support_max_relaxed_add(
        ctx, req, support_top_options, support_second_options, players, repeatable_ids
    )
    total_ub = baseline + best_craft_score + support_add

    if req.strategy == STRATEGY_TARGET_MAX:
        # target_max 的 score = target_value * 10000 + total_score。
        # 这里用“只针对 target 的松弛分数”再跑一次小 DP，得到 target 的保守上界，
        # 避免全队 DP 的最优组合不一定是 target 最优组合。
        target_players = [p for p in players if p.servant_id == req.target_servant_id]
        if not target_players or not any(p.counted for p in target_players):
            return total_ub
        target = target_players[0]
        target_inner = 1.0 + sum(p.counts_max_bond for p in players) * 0.25
        target_inner += (req.activity_bonus or 0.0)
        target_inner += sum(float(p.aura_bonus or 0.0) for p in players)
        target_inner += target.personal_bonus
        target_base = _relaxed_percent_weight(req) * target.front_factor * target_inner
        target_scores = _make_craft_score_map(ctx, req, target_players, candidate_craft_ids or [])
        target_dp = _dp_top_craft_combinations(
            ctx,
            candidate_craft_ids or [],
            free_slots_count,
            cost_budget,
            _repeatable_craft_ids(ctx),
            zero_cost_slots,
            target_scores,
            top_k=1,
        )
        target_craft_ub = (
            _combo_relaxed_score(target_dp[0][1], target_scores)
            if target_dp else 0.0
        )
        # 固定礼装效果同样要计入 target 上界。
        fixed_target_score = sum(
            _relaxed_craft_score(ctx, req, ctx.crafts.get(cid), target_players)
            for cid in (fixed_bond_craft_ids or [])
        )
        # support_add 是全队松弛加分，作为 target 单人的上界也安全（只高不低）。
        target_ub = target_base + target_craft_ub + fixed_target_score + support_add
        return total_ub + target_ub * 10000.0
    return total_ub


def _collect_used_trait_craft_ids(
    ctx: DataContext,
    best_by_set: Dict[Tuple[int, ...], Dict[str, Any]],
) -> Set[int]:
    """从第一轮已找到的队伍中，收集实际产生收益的特性礼装。"""
    used: Set[int] = set()
    for entry in best_by_set.values():
        team = entry.get("team")
        if team is None:
            continue
        for p in getattr(team, "players", []):
            for cid in (getattr(p, "craft_id", None), getattr(p, "second_craft_id", None)):
                if cid is None:
                    continue
                craft = ctx.crafts.get(cid)
                if craft is not None and craft.bonus_type == "trait":
                    used.add(cid)
        for cid in (getattr(team, "support_craft_id", None), getattr(team, "support_second_craft_id", None)):
            if cid is None:
                continue
            craft = ctx.crafts.get(cid)
            if craft is not None and craft.bonus_type == "trait":
                used.add(cid)
    return used


def _expand_reduced_for_trait_synergy(
    ctx: DataContext,
    req: CalculationRequest,
    bp: Blueprint,
    box: Dict[int, BoxServant],
    reduced: Sequence[int],
    player_candidates: Sequence[int],
    trait_ids: Sequence[int],
    used_trait_craft_ids: Set[int],
) -> List[int]:
    """第二轮补池：补入“多触发/特性协同”但从静态启发式看不够靠前的从者。

    - 多触发：能同时匹配多张特性礼装的从者，容易在真实组队里形成高价值协同。
    - 固定队协同：固定从者已经能触发某张特性礼装时，补入同类从者往往能放大收益。
    - 首轮线索：第一轮实际用到的特性礼装，第二轮优先补能触发它们的从者。
    """
    if len(player_candidates) <= len(reduced):
        return list(reduced)

    reduced_set = set(reduced)
    additions: List[int] = []

    # 固定玩家能触发的特性礼装
    fixed_matching_cids: Set[int] = set()
    for cid in trait_ids:
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        for pm in bp.fixed_player_members:
            if _servant_can_match_craft_any_stage(ctx, pm.servant_id, craft):
                fixed_matching_cids.add(cid)
                break

    priority_cids = set(used_trait_craft_ids) | fixed_matching_cids

    max_add = 20 if len(bp.free_servant_positions) <= 2 else 10

    # 1) 多触发候选：即使单从者分不高，也可能因同时命中多张礼装而价值高。
    multi_sorted = sorted(
        player_candidates,
        key=lambda sid: (
            -_multi_trait_count(ctx, sid, trait_ids),
            -_servant_heuristic(ctx, box[sid], trait_ids),
            sid,
        ),
    )
    for sid in multi_sorted:
        if len(additions) >= max_add:
            break
        if sid in reduced_set:
            continue
        # 只补至少能命中一个“优先特性”或“多触发”的候选
        if priority_cids:
            if not _matches_any_trait_craft(ctx, sid, list(priority_cids)):
                continue
        else:
            if _multi_trait_count(ctx, sid, trait_ids) <= 0:
                continue
        additions.append(sid)
        reduced_set.add(sid)

    # 2) 特性组保底/固定队协同补人：每个高优先级特性礼装至少保证池内有可触发者。
    heuristic_sorted = sorted(
        player_candidates,
        key=lambda sid: (_servant_heuristic(ctx, box[sid], trait_ids), sid),
        reverse=True,
    )
    for cid in trait_ids:
        if len(additions) >= max_add:
            break
        craft = ctx.crafts.get(cid)
        if craft is None:
            continue
        represented = any(
            _servant_can_match_craft_any_stage(ctx, sid, craft)
            for sid in reduced_set
        )
        if represented and cid not in priority_cids:
            continue
        for sid in heuristic_sorted:
            if len(additions) >= max_add:
                break
            if sid in reduced_set:
                continue
            if _servant_can_match_craft_any_stage(ctx, sid, craft):
                additions.append(sid)
                reduced_set.add(sid)
                break

    # 第二轮把补入候选放到前面，优先探索这些“新面孔”，避免时间被旧高分前缀耗尽。
    return list(additions) + [sid for sid in reduced if sid not in additions]


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
    # 候选从者：Box 中未被固定玩家使用的，且符合当前职阶筛选。
    # 助战位从者不占用玩家位，也不参与“选谁收益最大”的优化，因此不排除它。
    fixed_player_ids = set(bp.fixed_servant_ids)
    player_candidates = [
        sid for sid, bs in box.items()
        if sid not in fixed_player_ids
        and sid not in req.excluded_servant_ids
        and _servant_in_class_group(ctx, sid, req.class_group)
    ]

    # Cost 可行性预检：如果“最省配置”都超上限，提前给出明确提示
    fixed_cost = 0
    for slot in bp.player_slots:
        if slot.fixed_servant_id is not None:
            s_info = ctx.servants.get(slot.fixed_servant_id)
            if s_info:
                fixed_cost += s_info.cost
        for cid in (slot.fixed_craft_id, slot.fixed_second_craft_id):
            if cid is None:
                continue
            c_info = ctx.crafts.get(cid)
            if c_info and c_info.support_bonus > 0:
                raise ValueError("迦勒底午茶时光等助战加成礼装只能放在助战位")
            # 第二礼装位 0 Cost，只校验类型，不累加
            if cid == slot.fixed_craft_id and c_info:
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
    repeatable_ids = _repeatable_craft_ids(ctx)
    # 固定礼装已占用的牵绊礼装不再进入可挑选池（不重复使用同一张）。
    # 例外：可重复礼装即使已固定，仍允许继续放入自由位。
    used_craft_ids = {
        cid for cid in bp.fixed_bond_craft_ids
        if cid not in repeatable_ids
    }
    bond_candidates = [
        cid for cid, craft in ctx.crafts.items()
        if craft.is_bond_ce
        and cid not in used_craft_ids
        and cid not in req.excluded_craft_ids
        and not _is_merged_generic_universal5(ctx, cid)
        and not _is_event_limited_craft(ctx, cid)
        and not _is_ouma_craft(ctx, cid)
        # 需求过滤：满破 2.5% 及以下的低价值牵绊礼装不进入推荐池；
        # 自定义礼装只要设置了固定数值加成也进入候选；通用礼装由前端参与开关控制。
        and (craft.bonus_value > 0.025 or craft.support_bonus > 0.025 or craft.flat_bonus > 0 or cid in GENERIC_BOND_CRAFT_IDS)
        # 午茶等带“助战加成”的礼装只能放助战位，不能进玩家自由位
        and craft.support_bonus <= 0
    ]
    bond_candidates.sort(key=lambda cid: (
        ctx.crafts[cid].bonus_type != "universal",
        -ctx.crafts[cid].bonus_value,
        -ctx.crafts[cid].flat_bonus,
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
    free_bond_zero_cost = [
        cs.index == 1 for cs in bp.player_craft_slots if cs.fixed_craft_id is None
    ]
    craft_combos_with_cost = _generate_craft_combinations_with_cost(
        ctx, craft_pool, free_slots_count,
        max_total=_default_craft_combo_limit(req),
        zero_cost_slots=free_bond_zero_cost,
    )

    support_servant_id = bp.support_servant_id
    # 助战礼装位参与计算：主礼装未手动指定时枚举午茶/普通通用/特性礼装，
    # 冠位第二礼装位始终用“自动可选池”，不受主礼装手动选择影响。
    support_craft_options = _support_craft_options(ctx, req)
    support_auto_craft_options = _auto_support_craft_options(ctx, req)
    support_crown = bp.support_position in bp.crown_positions
    support_top_options = (
        [bp.support_craft_id] if bp.support_craft_id is not None else list(support_craft_options)
    )
    support_second_options = (
        [bp.support_second_craft_id]
        if bp.support_second_craft_id is not None
        else (list(support_auto_craft_options) if support_crown else [])
    )

    best_by_set: Dict[Tuple[int, ...], Dict[str, Any]] = {}
    seen: Set[Tuple[Any, ...]] = set()
    global_best_score: Optional[float] = None
    processed_total = 0
    evaluated_total = 0
    timeout_seconds = req.timeout_ms / 1000.0

    def _score_from_metrics(metrics, team, multipliers):
        flat_bonuses = metrics.get("flatBonuses", [0.0] * len(multipliers))
        total_flat = metrics.get("totalFlatBonus", 0.0)
        total_mult = metrics["totalMultiplier"]
        base_bond = float(team.base_bond or 0.0)
        use_points = bool(base_bond or total_flat)
        total_score = (total_mult * base_bond + total_flat) if use_points else total_mult

        if req.strategy == STRATEGY_TARGET_MAX:
            target_id = req.target_servant_id
            target_idx = next(
                (i for i, p in enumerate(team.players) if p.servant_id == target_id),
                None,
            )
            if target_idx is None:
                target_value = 0.0
            elif use_points:
                target_value = multipliers[target_idx] * base_bond + flat_bonuses[target_idx]
            else:
                target_value = multipliers[target_idx]
            return target_value * 10000 + total_score
        if req.strategy == STRATEGY_BALANCED:
            vals = (
                [m * base_bond + f for m, f in zip(multipliers, flat_bonuses)]
                if use_points
                else multipliers
            )
            avg = (sum(vals) / len(vals)) if vals else 0
            variance = sum((v - avg) ** 2 for v in vals) / len(vals) if vals else 0
            return total_score * 0.85 - variance * 2.0
        return total_score

    def _optimize_free_positions(team):
        """对自由位从者做小规模全排列优化，避免启发式放位漏掉明显更好的交换。

        只调整自由位上的从者顺序；固定从者、每个位置的礼装/第二礼装都保持不变。
        位置数最多 5 个（5! = 120），只会用于精算后的少数队伍，不会造成组合爆炸。
        """
        free_positions = sorted(bp.free_servant_positions, key=POSITIONS.index)
        if len(free_positions) <= 1:
            return team
        by_pos = {p.position: p for p in team.players}
        try:
            current_sids = [by_pos[pos].servant_id for pos in free_positions]
        except KeyError:
            return team
        if len(set(current_sids)) != len(current_sids):
            return team
        fixed_players = [p for p in team.players if p.position not in set(free_positions)]

        def build_candidate(perm):
            players = []
            for p in fixed_players:
                players.append(PlacedMember(
                    position=p.position,
                    servant_id=p.servant_id,
                    stage=p.stage,
                    personal_bonus=p.personal_bonus,
                    aura_bonus=p.aura_bonus,
                    max_bond=p.max_bond,
                    bond_switch1=p.bond_switch1,
                    bond_switch2=p.bond_switch2,
                    craft_id=p.craft_id,
                    second_craft_id=p.second_craft_id,
                    is_crown=p.is_crown,
                    fixed=p.fixed,
                    stage_locked=p.stage_locked,
                ))
            for pos, sid in zip(free_positions, perm):
                slot = by_pos[pos]
                bs = box.get(sid)
                players.append(PlacedMember(
                    position=pos,
                    servant_id=sid,
                    stage=bs.stage if bs else "fourth",
                    personal_bonus=bs.personal_bonus if bs else 0.0,
                    aura_bonus=bs.aura_bonus if bs else 0.0,
                    max_bond=bs.max_bond if bs else False,
                    bond_switch1=bs.bond_switch1 if bs else False,
                    bond_switch2=bs.bond_switch2 if bs else False,
                    craft_id=slot.craft_id,
                    second_craft_id=slot.second_craft_id,
                    is_crown=slot.is_crown,
                    fixed=False,
                    stage_locked=False,
                ))
            return TeamConfig(
                players=players,
                support_position=team.support_position,
                support_servant_id=team.support_servant_id,
                support_craft_id=team.support_craft_id,
                support_second_craft_id=team.support_second_craft_id,
                crown_positions=team.crown_positions,
                base_bond=team.base_bond,
                activity_bonus=team.activity_bonus,
            )

        best_team = team
        initial_metrics = calculator.calculate_team_metrics(ctx, team)
        best_score = _score_from_metrics(initial_metrics, team, initial_metrics["multipliers"])
        for perm in set(itertools.permutations(current_sids)):
            candidate = build_candidate(perm)
            candidate = calculator.optimize_team_stages(ctx, candidate)
            metrics = calculator.calculate_team_metrics(ctx, candidate)
            score = _score_from_metrics(metrics, candidate, metrics["multipliers"])
            if score > best_score + 1e-9:
                best_score = score
                best_team = candidate
        return best_team

    def evaluate_extras(extras_tuple, craft_combos=None, use_dp=False):
        nonlocal seen, evaluated_total, global_best_score
        original_craft_combos = craft_combos
        used_players = set(bp.fixed_servant_ids) | set(extras_tuple)
        if (
            req.strategy == STRATEGY_TARGET_MAX
            and req.target_servant_id is not None
            and req.target_servant_id not in used_players
        ):
            return None
        servant_set = tuple(sorted(used_players))

        support_id = support_servant_id
        if support_id is None:
            support_id = _choose_support(ctx, req, used_players, box)
            if support_id is None:
                return None

        mapping = _greedy_mapping(ctx, box, extras_tuple, bp.free_servant_positions)

        # 玩家从者 Cost + 固定礼装 Cost 后，剩余才是可分配给自由礼装位的预算
        servant_cost = sum(ctx.servants[sid].cost for sid in used_players if sid in ctx.servants)
        ce_budget = req.cost_limit - servant_cost - fixed_craft_cost
        if ce_budget < 0:
            return None

        team_support_options = (
            list(support_top_options)
            if bp.support_craft_id is not None
            else _filter_support_options_for_team(ctx, support_top_options, used_players)
        )
        team_support_second_options = (
            list(support_second_options)
            if bp.support_second_craft_id is not None
            else (_filter_support_options_for_team(ctx, support_second_options, used_players) if support_second_options else [])
        )

        # 固定从者阵容后先生成松弛 DP 礼装组合；该结果同时用于：
        # 1) 上界剪枝（松弛只高估，可安全跳过不可能超过当前 best 的阵容）
        # 2) 粗搜轮用 DP 结果替代全局礼装抽样（精算轮仍走完整 full_combos）
        dp_players: Optional[List[_RelaxedPlayer]] = None
        craft_scores: Dict[int, float] = {}
        dp_combos: List[Tuple[int, Tuple[int, ...]]] = []
        if use_dp or global_best_score is not None:
            dp_players, craft_scores, dp_combos = _prepare_dp_craft_combos_for_team(
                ctx,
                req,
                bp,
                box,
                mapping,
                craft_pool,
                ce_budget,
                free_bond_zero_cost,
                top_k=12,
            )
            if dp_players:
                ub = _relaxed_score_upper_bound(
                    ctx,
                    req,
                    dp_players,
                    craft_scores,
                    dp_combos,
                    support_top_options,
                    support_second_options,
                    candidate_craft_ids=craft_pool,
                    free_slots_count=free_slots_count,
                    cost_budget=ce_budget,
                    zero_cost_slots=free_bond_zero_cost,
                    fixed_bond_craft_ids=bp.fixed_bond_craft_ids,
                )
                # 剪枝目标是“Top-N 阈值”，不是“当前最高分”：
                # 否则会把所有低于当前第一名的队伍全剪掉，只剩一个结果。
                if len(best_by_set) >= req.top_n:
                    cutoff_scores = sorted(
                        (e["score"] for e in best_by_set.values()),
                        reverse=True,
                    )
                    cutoff = cutoff_scores[req.top_n - 1]
                    if ub < cutoff - 1e-9:
                        return None
            if use_dp:
                # DP 组合优先，再并入原有的全局抽样组合，兼顾“阵容专属协同”与
                # “旧抽样多样性”，避免粗搜只依赖单一启发式。
                if original_craft_combos is None:
                    craft_combos = dp_combos
                else:
                    seen_combos = {combo for _, combo in dp_combos}
                    merged = list(dp_combos)
                    for cost, combo in original_craft_combos:
                        if combo not in seen_combos:
                            merged.append((cost, combo))
                    craft_combos = merged

        if craft_combos is None:
            craft_combos = [(0, ())]

        best_here = best_by_set.get(servant_set)
        for craft_cost, craft_choice in craft_combos:
            if craft_cost > ce_budget:
                continue
            for support_craft_id in team_support_options:
                # 非冠位助战没有第二礼装位；只有手动/自动给了第二候选才枚举
                second_ids = team_support_second_options or [None]
                for support_second_craft_id in second_ids:
                    if (
                        support_second_craft_id is not None
                        and support_craft_id is not None
                        and support_second_craft_id == support_craft_id
                        and support_second_craft_id not in repeatable_ids
                        and support_second_craft_id > 0
                    ):
                        continue
                    team = _make_team_config(
                        ctx,
                        req,
                        bp,
                        extras_tuple,
                        mapping,
                        craft_choice,
                        support_id,
                        support_craft_id,
                        support_second_craft_id=support_second_craft_id,
                    )
                    if team is None:
                        continue
                    # 阶段不再由用户手动指定：根据当前礼装组合自动选择最优阶段/灵衣
                    # 把 DP/粗搜可能留下的空槽补满，避免“Cost 还有剩余却无礼装”
                    team = _fill_remaining_craft_slots(ctx, req, bp, team, craft_pool)
                    team = calculator.optimize_team_stages(ctx, team)

                    key = tuple(
                        (p.position, p.servant_id, p.craft_id, p.second_craft_id)
                        for p in sorted(team.players, key=lambda x: x.position)
                    ) + ((team.support_position, team.support_servant_id, team.support_craft_id, team.support_second_craft_id),)
                    if key in seen:
                        continue
                    seen.add(key)

                    metrics = calculator.calculate_team_metrics(ctx, team)
                    evaluated_total += 1
                    score = _score_from_metrics(metrics, team, metrics["multipliers"])

                    old = best_by_set.get(servant_set)
                    if old is None or score > old["score"] + 1e-9:
                        best_by_set[servant_set] = {
                            "score": score,
                            "team": team,
                            "servant_set": servant_set,
                        }
                        best_here = best_by_set[servant_set]
                        if global_best_score is None or score > global_best_score:
                            global_best_score = score
        return best_here

    def run_with_craft_combos(
        candidate_ids,
        deadline,
        craft_combos,
        servant_limit=None,
        use_dp=False,
        max_processed: Optional[int] = None,
    ):
        nonlocal processed_total
        processed = 0
        combos_iter = (
            _sample_servant_combinations(candidate_ids, choose_count, servant_limit)
            if servant_limit is not None
            else _generate_servant_combinations(candidate_ids, choose_count)
        )
        for extras_tuple in combos_iter:
            if max_processed is not None:
                if processed >= max_processed:
                    break
            elif time.time() >= deadline:
                report("达到时间预算，提前结束当前轮搜索")
                break
            used_players = set(bp.fixed_servant_ids) | set(extras_tuple)
            servant_set = tuple(sorted(used_players))
            # 已经见过的从者组合在粗搜轮不再重复；精算轮用 evaluate_extras 单独补全。
            if servant_set in best_by_set:
                processed += 1
                processed_total += 1
                continue
            evaluate_extras(extras_tuple, craft_combos, use_dp=use_dp)
            processed += 1
            processed_total += 1
            if progress and (processed % 100 == 0 or processed == 1):
                elapsed = time.time() - start
                report(
                    f"已评估 {evaluated_total:,} 个队伍配置"
                    f"（时间预算 {timeout_seconds:.0f}s，当前 {elapsed:.1f}s）"
                )

    # 复现模式：用原计算的“分阶段处理数量”代替墙钟时间作为停止条件。
    # 这样即使短验证串搜索更快，也会在完全相同的进度点停下，结果可精确复现。
    phase_limits = getattr(req, "verify_phase_limits", None)
    if not (isinstance(phase_limits, dict) and "firstProcessed" in phase_limits):
        phase_limits = None

    # 粗搜：只对每个被抽到的从者阵容跑“该阵容专属 DP 礼装组合”，
    # 尽量覆盖更多从者组合；完整礼装组合留给少量 Top 精算。
    full_combos = list(craft_combos_with_cost)
    servant_sweep_limit = max(200, min(1500, int(timeout_seconds * 40)))

    # 第一轮：用静态分候选池快速建立 Top 基线（对从者组合等距抽样，覆盖更广）。
    first_deadline = start + min(timeout_seconds, max(5.0, timeout_seconds * 0.5))
    first_limit = int(phase_limits.get("firstProcessed", 0)) if phase_limits else None
    before_first = processed_total
    run_with_craft_combos(
        reduced,
        first_deadline,
        None,
        servant_limit=servant_sweep_limit,
        use_dp=True,
        max_processed=first_limit,
    )
    first_processed = processed_total - before_first

    # 第二轮：根据第一轮实际用到的特性礼装 + 固定队协同补人后再粗搜。
    second_ran = False
    second_processed = 0
    if phase_limits is not None:
        should_run_second = bool(phase_limits.get("secondRan"))
    else:
        should_run_second = time.time() < start + timeout_seconds - 3 and bool(best_by_set)
    if should_run_second:
        used_trait_craft_ids = _collect_used_trait_craft_ids(ctx, best_by_set)
        expanded = _expand_reduced_for_trait_synergy(
            ctx,
            req,
            bp,
            box,
            reduced,
            player_candidates,
            trait_ids,
            used_trait_craft_ids,
        )
        if len(expanded) > len(reduced):
            added = len(expanded) - len(reduced)
            report(f"第二轮补入 {added} 名协同候选，继续搜索...")
            second_deadline = start + min(timeout_seconds, max(5.0, timeout_seconds * 0.75))
            second_limit = int(phase_limits.get("secondProcessed", 0)) if phase_limits else None
            before_second = processed_total
            run_with_craft_combos(
                expanded,
                second_deadline,
                None,
                servant_limit=servant_sweep_limit,
                use_dp=True,
                max_processed=second_limit,
            )
            second_processed = processed_total - before_second
            second_ran = True

    # 精算：只对当前分数最高的少数从者组合，用完整礼装组合重新精确求解。
    refine_count = max(5, min(15, len(best_by_set)))
    refine_entries = sorted(
        best_by_set.values(),
        key=lambda x: x["score"],
        reverse=True,
    )[:refine_count]
    refine_deadline = start + timeout_seconds
    refine_processed = 0
    for entry in refine_entries:
        if phase_limits is not None:
            if refine_processed >= int(phase_limits.get("refineProcessed", 0)):
                break
        elif time.time() >= refine_deadline:
            break
        refine_processed += 1
        servant_set = entry.get("servant_set")
        if not servant_set:
            continue
        extras_tuple = tuple(sorted(set(servant_set) - set(bp.fixed_servant_ids)))
        evaluate_extras(extras_tuple, full_combos)

    # 精算后对每个进入精算的从者阵容做一次自由位排列优化，修正启发式放位漏掉的交换。
    # 该兜底有额外算力成本，只保留在最后两个高算力档位（高质量/极限精算）。
    optimize_processed = 0
    if req.timeout_ms >= 135000:
        for entry in refine_entries:
            if phase_limits is not None:
                if optimize_processed >= int(phase_limits.get("optimizeProcessed", 0)):
                    break
            elif time.time() >= refine_deadline:
                break
            optimize_processed += 1
            servant_set = entry.get("servant_set")
            if not servant_set:
                continue
            current = best_by_set.get(servant_set)
            if not current:
                continue
            optimized = _optimize_free_positions(current["team"])
            metrics = calculator.calculate_team_metrics(ctx, optimized)
            score = _score_from_metrics(metrics, optimized, metrics["multipliers"])
            if score > current["score"] + 1e-9:
                current["team"] = optimized
                current["score"] = score
                if global_best_score is None or score > global_best_score:
                    global_best_score = score

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
        "_verifyPhase": {
            "firstProcessed": first_processed,
            "secondRan": second_ran,
            "secondProcessed": second_processed,
            "refineProcessed": refine_processed,
            "optimizeProcessed": optimize_processed,
        },
    }
