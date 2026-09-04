"""Task 2：计算引擎数据结构定义。

与任务书输入/输出 JSON 对应，同时兼容 UI 后续可能传入的扩展字段。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

# 队伍位置
POSITIONS = [
    "front_left",
    "front_middle",
    "front_right",
    "back_left",
    "back_middle",
    "back_right",
]
FRONT_POSITIONS = {"front_left", "front_middle", "front_right"}

# 策略
STRATEGY_TOTAL_MAX = "total_max"
STRATEGY_TARGET_MAX = "target_max"
STRATEGY_BALANCED = "balanced"

# 策略中“指定从者”的字段名
TARGET_SERVANT_KEY = "targetServantId"


@dataclass
class BoxServant:
    servant_id: int
    stage: str = "fourth"
    max_bond: bool = False
    bond_switch1: bool = False
    bond_switch2: bool = False
    personal_bonus: float = 0.0
    aura_bonus: float = 0.0
    # 运行时从数据库补全
    name: str = ""
    servant_class: str = ""
    cost: int = 0
    rarity: int = 0
    traits: set = field(default_factory=set)

    @property
    def count_in_team_bonus(self) -> bool:
        """是否参与全队满绊人数统计（开关一）。"""
        return self.max_bond and self.bond_switch1

    @property
    def count_personal_bond(self) -> bool:
        """该从者个人收益是否计入。

        只有助战除外；满绊且关闭开关二的从者个人收益为 0。
        关闭开关一但开启开关二的非法状态由 UI 层阻止，这里按开关二为准。
        """
        if self.max_bond and not self.bond_switch2:
            return False
        return True


@dataclass
class FixedServant:
    servant_id: int
    position: Optional[str] = None  # None = 自动分配剩余位置
    stage: Optional[str] = None     # 用户锁定阶段/灵衣；None = 引擎自动选择


@dataclass
class FixedCraft:
    position: str
    craft_id: int
    type: str = "bond"  # bond / other


@dataclass
class SupportConfig:
    servant_id: Optional[int] = None
    craft_id: Optional[int] = None
    # 扩展：UI 可指定助战位置；默认 back_right
    position: Optional[str] = None


@dataclass
class CalculationRequest:
    box: List[BoxServant] = field(default_factory=list)
    fixed_servants: List[FixedServant] = field(default_factory=list)
    fixed_crafts: List[FixedCraft] = field(default_factory=list)
    support: Optional[SupportConfig] = None
    cost_limit: int = 114
    strategy: str = STRATEGY_TOTAL_MAX
    excluded_servant_ids: Set[int] = field(default_factory=set)
    excluded_craft_ids: Set[int] = field(default_factory=set)
    activity_bonus: float = 0.0
    tea_bonus: float = 1.0  # 1 表示使用午茶/助战加成档位
    # 算法参数
    candidate_pool_size: int = 30
    craft_pool_size: int = 10
    top_n: int = 20
    timeout_ms: int = 10000
    target_servant_id: Optional[int] = None


@dataclass
class TeamMember:
    position: str
    servant_id: int
    name: str
    stage: str
    is_support: bool = False
    is_fixed: bool = False
    is_max_bond: bool = False
    craft_id: Optional[int] = None
    craft_name: str = ""
    craft_type: str = "other"  # bond / other / none
    bonus_detail: Optional[Dict[str, Any]] = None


@dataclass
class TeamSolution:
    rank: int = 0
    total_multiplier: float = 0.0
    cost_used: int = 0
    team: List[TeamMember] = field(default_factory=list)
    max_bond_stats: Dict[str, Any] = field(default_factory=dict)
    trait_coverage: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# JSON 解析助手
# ---------------------------------------------------------------------------
def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).lower() in {"1", "true", "yes", "on"}


def parse_box(raw_list: List[Dict[str, Any]]) -> List[BoxServant]:
    result: List[BoxServant] = []
    for raw in raw_list or []:
        result.append(
            BoxServant(
                servant_id=int(raw["id"]),
                stage=str(raw.get("stage", "fourth")),
                max_bond=_as_bool(raw.get("maxBond"), False),
                bond_switch1=_as_bool(raw.get("bondSwitch1"), True),
                bond_switch2=_as_bool(raw.get("bondSwitch2"), False),
                personal_bonus=float(raw.get("personalBonus", 0) or 0),
                aura_bonus=float(raw.get("auraBonus", 0) or 0),
            )
        )
    return result


def parse_fixed_servants(raw_list: List[Any]) -> List[FixedServant]:
    result: List[FixedServant] = []
    for raw in raw_list or []:
        if isinstance(raw, dict):
            result.append(
                FixedServant(
                    servant_id=int(raw.get("servantId") or raw.get("id")),
                    position=raw.get("position"),
                    stage=raw.get("stage"),
                )
            )
        else:
            result.append(FixedServant(servant_id=int(raw)))
    return result


def parse_fixed_crafts(raw_list: List[Dict[str, Any]]) -> List[FixedCraft]:
    result: List[FixedCraft] = []
    for raw in raw_list or []:
        result.append(
            FixedCraft(
                position=str(raw["position"]),
                craft_id=int(raw["craftId"]),
                type=str(raw.get("type", "bond")).lower(),
            )
        )
    return result


def parse_support(raw: Any) -> Optional[SupportConfig]:
    if not raw:
        return None
    if isinstance(raw, dict):
        has_servant = raw.get("servantId") is not None
        has_craft = raw.get("craftId") is not None
        if not has_servant and not has_craft:
            # 空对象表示“由系统推荐”（助战礼装自动参与计算）
            return SupportConfig()
        servant_id = raw.get("servantId")
        craft_id = raw.get("craftId")
        position = raw.get("position")
        return SupportConfig(
            servant_id=int(servant_id) if servant_id is not None else None,
            craft_id=int(craft_id) if craft_id is not None else None,
            position=position,
        )
    return None


def parse_request(data: Dict[str, Any]) -> CalculationRequest:
    """把输入 JSON 转为 CalculationRequest。"""
    strategy = data.get("strategy") or STRATEGY_TOTAL_MAX
    req = CalculationRequest(
        box=parse_box(data.get("box") or []),
        fixed_servants=parse_fixed_servants(data.get("fixedServants") or []),
        fixed_crafts=parse_fixed_crafts(data.get("fixedCrafts") or []),
        support=parse_support(data.get("support")),
        cost_limit=int(data.get("costLimit", 114) or 114),
        strategy=strategy,
        excluded_servant_ids={int(x) for x in (data.get("excludedServantIds") or [])},
        excluded_craft_ids={int(x) for x in (data.get("excludedCraftIds") or [])},
        activity_bonus=float(data.get("activityBonus", 0) or 0),
        tea_bonus=float(data.get("teaBonus", 1) or 1),
        top_n=int(data.get("topN", 20) or 20),
        timeout_ms=int(data.get("timeoutMs", 10000) or 10000),
    )
    req.candidate_pool_size = int(data.get("candidatePoolSize", 30) or 30)
    req.craft_pool_size = int(data.get("craftPoolSize", 10) or 10)
    if strategy == STRATEGY_TARGET_MAX:
        req.target_servant_id = data.get("targetServantId") or data.get(TARGET_SERVANT_KEY)
    return req
