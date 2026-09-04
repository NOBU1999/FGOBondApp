"""FGO 牵绊收益推荐系统 - 常量与路径配置.

Task 1: 数据层常量。
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# 区域选择
# 文档/需求使用中文名称，默认使用 Atlas Academy CN 区数据；
# 可通过环境变量 FGO_REGION 覆盖为 JP/NA/CN/KR/TW。
# ---------------------------------------------------------------------------
DEFAULT_REGION = os.environ.get("FGO_REGION", "JP").upper()
SUPPORTED_REGIONS = {"JP", "NA", "CN", "KR", "TW"}

# ---------------------------------------------------------------------------
# Atlas Academy API
# ---------------------------------------------------------------------------
ATLAS_API_ROOT = "https://api.atlasacademy.io"
ATLAS_EXPORT_ROOT = f"{ATLAS_API_ROOT}/export/{{region}}"

# 导出文件名：nice 层包含 cost/skills/traits 等完整字段
NICE_SERVANT_FILE = "nice_servant.json"
NICE_EQUIP_FILE = "nice_equip.json"
NICE_EVENT_FILE = "nice_event.json"

# 工程目录定位（开发态）
# constants.py 位于 FGOBondApp/python-engine/engine/constants.py
ENGINE_PACKAGE_DIR = Path(__file__).resolve().parent          # .../python-engine/engine
ENGINE_ROOT = ENGINE_PACKAGE_DIR.parent                        # .../python-engine
PROJECT_ROOT = ENGINE_ROOT.parent                              # .../FGOBondApp

# 可通过环境变量覆盖，便于打包后/测试时指定
DB_PATH = Path(os.environ.get("FGO_DB_PATH", str(PROJECT_ROOT / "db" / "fgo_data.db")))
RAW_CACHE_DIR = Path(
    os.environ.get("FGO_RAW_CACHE_DIR", str(ENGINE_ROOT / ".cache" / "raw"))
)

# ---------------------------------------------------------------------------
# 灵基阶段
# UI/DB 使用下列英文键；Atlas ascensionAdd 使用 0~4 数字字符串。
# ---------------------------------------------------------------------------
STAGES = ("initial", "first", "second", "third", "fourth")
ASCENSION_KEYS = ("0", "1", "2", "3", "4")
STAGE_TO_ASCENSION = dict(zip(STAGES, ASCENSION_KEYS))
ASCENSION_TO_STAGE = dict(zip(ASCENSION_KEYS, STAGES))

# 默认阶段
DEFAULT_STAGE = "fourth"

# ---------------------------------------------------------------------------
# SQLite schema 版本（便于以后升级时做迁移）
# ---------------------------------------------------------------------------
SCHEMA_VERSION = 1

# 配置
DEFAULT_COST_LIMIT = 114
