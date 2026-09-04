"""灵基阶段特性差异硬编码映射表（Task 1 必需交付物之一）。

背景
----
原任务书 4.1 要求将这些“Atlas API 不直接提供/需要人工确认”的灵基阶段特性差异
硬编码在 Python 引擎中。当前 Atlas Academy nice 数据里很多从者已通过
`ascensionAdd.individuality.ascension` 提供完整分阶段特性，本表仍保留作为：
1. 文档要求的人工映射表；
2. API 缺失或异常时的兜底补丁；
3. 后续人工维护的“权威差异清单”。

注意
----
文档使用中文特性名，Atlas API 内部 trait 名为英文/机器名。
本模块统一保存 Atlas 机器名，便于直接和 `servant.traits` / `craft.skills` 匹配。
"""

from __future__ import annotations

from typing import Dict, List

# trait 中文名 -> Atlas 机器名（仅用于本表可读性）
TRAIT_ALIAS: Dict[str, str] = {
    "人科": "hominidaeServant",
    "魔兽型": "demonicBeastServant",
    "兽科": "havingAnimalsCharacteristics",
    "圆桌骑士": "knightsOfTheRound",
    "孩童": "childServant",
    "秩序": "alignmentLawful",
    "混沌": "alignmentChaotic",
    "中立": "alignmentNeutral",
    "善": "alignmentGood",
    "中庸": "alignmentBalanced",
    "恶": "alignmentEvil",
    "夏": "alignmentSummer",
    "活在当下的人类": "livingHuman",
    "灵衣": "hasCostume",
}

# 阶段键与任务书一致：initial/first/second/third/fourth
# 值表示该从者在对应灵基阶段“特性差异清单”中的 trait 机器名。
# 若某阶段为空列表，表示该阶段没有额外/差异特性。
STAGE_TRAIT_OVERRIDES: Dict[int, Dict[str, List[str]]] = {
    # 水院院（泳装杀生院 / Sessyoin Kiara Moon Cancer）
    2300400: {
        "initial": ["hominidaeServant"],
        "first": ["hominidaeServant"],
        "second": ["hominidaeServant"],
        "third": ["demonicBeastServant", "havingAnimalsCharacteristics"],
        "fourth": ["demonicBeastServant", "havingAnimalsCharacteristics"],
    },
    # 妖兰 / 妖高 / 妖崔（圆桌骑士组）
    # Melusine / Barghest / Baobhan Sith
    304800: {  # Melusine
        "initial": ["knightsOfTheRound"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
    105000: {  # Barghest
        "initial": ["knightsOfTheRound"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
    204300: {  # Baobhan Sith
        "initial": ["knightsOfTheRound"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
    # 救世主托内莉可（Aesc the Rain Witch）
    505300: {
        "first": ["alignmentLawful", "alignmentGood"],
        "second": ["alignmentLawful", "alignmentBalanced"],
        "third": ["alignmentLawful", "alignmentSummer"],
        "fourth": ["alignmentLawful", "alignmentSummer"],
    },
    # 久远寺有珠（Kuonji Alice）
    505500: {
        "first": ["alignmentChaotic", "alignmentGood"],
        "second": ["alignmentChaotic", "alignmentGood"],
        "third": ["alignmentChaotic", "alignmentEvil"],
        "fourth": ["alignmentChaotic", "alignmentEvil"],
    },
    # Archetype:Earth
    2300500: {
        "first": ["alignmentChaotic", "alignmentGood"],
        "second": ["alignmentNeutral", "alignmentGood"],
        "third": ["alignmentChaotic", "alignmentGood"],
        "fourth": ["alignmentChaotic", "alignmentGood"],
    },
    # 童谣（Nursery Rhyme）
    500400: {
        "initial": [],
        "first": [],
        "second": ["childServant"],
        "third": ["childServant"],
        "fourth": ["childServant"],
    },
    # 迦摩（Kama Assassin）与水迦摩（Kama Avenger）
    603700: {
        "initial": ["childServant"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
    1101100: {
        "initial": ["childServant"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
    # 鬼女红叶（Kijyo Koyo）
    703700: {
        "initial": ["demonicBeastServant"],
        "first": [],
        "second": [],
        "third": [],
        "fourth": [],
    },
}

# 上述映射覆盖的从者 ID 集合，便于测试/统计
KNOWN_STAGE_SPECIAL_SERVANTS = frozenset(STAGE_TRAIT_OVERRIDES.keys())


def get_stage_override(servant_id: int) -> Dict[str, List[str]]:
    """返回某个从者的硬编码阶段差异映射；没有则返回空 dict。"""
    return STAGE_TRAIT_OVERRIDES.get(int(servant_id), {})


def get_override_traits(servant_id: int, stage: str) -> List[str]:
    """返回某从者在某阶段的硬编码差异 trait 列表。"""
    override = get_stage_override(servant_id)
    return list(override.get(stage, []))
