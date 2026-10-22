"""灵基阶段/灵衣特性的人工补丁表（数据在 `data/stage_traits_patch.json`，本文件只负责读取）。

背景
----
任务书 4.1 要求把这些“Atlas API 不直接提供 / 需要人工确认”的灵基阶段特性差异
硬编码进引擎。当前 Atlas nice 数据里很多从者已通过 `ascensionAdd.individuality.ascension`
提供完整分阶段特性，本表仍保留作为：

1. 文档要求的人工映射表；
2. API 缺失或异常时的兜底补丁；
3. 后续人工维护的“权威差异清单”。

注意
----
- 文档/JSON 用中文特性名做可读性对照（`traitAlias`），实际匹配一律用 Atlas 机器名。
- 表本身是**数据**，搬到仓库根的 `data/` 下统一存放；本模块只保留读取与查询。
- 找不到数据文件时**不抛错**（它只是补丁）：返回空表并往 stderr 提示一句，
  避免「更新数据」因为一个可选补丁整条失败。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List


def _patch_file() -> Path:
    """补丁表位置：优先随包/构建产物目录（engine/data），否则退到仓库根 data/。"""
    bundled = Path(__file__).resolve().parent / "data" / "stage_traits_patch.json"
    if bundled.exists():
        return bundled
    return Path(__file__).resolve().parents[2] / "data" / "stage_traits_patch.json"


def _load() -> Dict[str, object]:
    path = _patch_file()
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # 补丁缺失不该让更新流程整条失败
        print(f"[warn] 读不到阶段特性补丁表 {path}：{exc}", file=sys.stderr)
        return {}
    return data if isinstance(data, dict) else {}


_DATA = _load()

# trait 中文名 -> Atlas 机器名（仅用于本表可读性）
TRAIT_ALIAS: Dict[str, str] = dict(_DATA.get("traitAlias") or {})

# 阶段键与任务书一致：initial/first/second/third/fourth
# 值表示该从者在对应灵基阶段“特性差异清单”中的 trait 机器名。
# 若某阶段为空列表，表示该阶段没有额外/差异特性。
STAGE_TRAIT_OVERRIDES: Dict[int, Dict[str, List[str]]] = {
    int(sid): {stage: list(traits) for stage, traits in stages.items()}
    for sid, stages in (_DATA.get("stageTraitOverrides") or {}).items()
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
