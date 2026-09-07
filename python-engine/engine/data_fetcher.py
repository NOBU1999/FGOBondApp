"""Atlas Academy API 数据拉取与 SQLite 全量构建（Task 1）。

用法
----
- 直接运行：`python -m engine.data_fetcher` 会重建 db/fgo_data.db。
- 供 init_db 脚本调用：`build_database(region="CN")`。

说明
----
- 默认从 Atlas Academy 的 nice 导出文件一次性拉取完整 JSON。
- nice_servant.json 包含 cost/rarity/traits/ascensionAdd 等；
  nice_equip.json 包含 cost/skills，可解析牵绊加成礼装。
- 下载使用流式落盘并输出进度，避免大文件长时间无反馈。
- 灵基阶段特性以 API ascensionAdd 优先，任务书硬编码映射表作为补丁。
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import database
from .constants import (
    ASCENSION_KEYS,
    ATLAS_EXPORT_ROOT,
    DEFAULT_REGION,
    NICE_EQUIP_FILE,
    NICE_SERVANT_FILE,
    RAW_CACHE_DIR,
    STAGES,
)
from .stage_trait_map import get_override_traits

# 下载超时（秒）
HTTP_TIMEOUT = 120
CHUNK_SIZE = 1024 * 1024  # 1 MiB

# 可进入玩家 Box 的从者 type（过滤敌方/NPC 等）
PLAYABLE_SERVANT_TYPES = {"normal", "heroine"}

# 礼装（Craft Essence）type
CRAFT_EQUIP_TYPES = {"servantEquip"}

# Atlas ascensionAdd.attribute 的取值 -> trait 机器名。
# 该字段会在部分从者 3破/4破/灵衣时整体改变“属性（天/地/人/星/兽）”。
ATTRIBUTE_VALUE_TO_TRAIT = {
    "star": "attributeStar",
    "sky": "attributeSky",
    "earth": "attributeEarth",
    "man": "attributeMan",
    "human": "attributeMan",
    "beast": "attributeBeast",
}
ATTRIBUTE_TRAIT_NAMES = set(ATTRIBUTE_VALUE_TO_TRAIT.values())

# 本地 Chaldea 翻译表（JP -> CN），由 scripts/update_name_translations.py 生成
_TRANSLATION_CACHE: Optional[Dict[str, Dict[str, str]]] = None


def _load_translations() -> Dict[str, Dict[str, str]]:
    global _TRANSLATION_CACHE
    if _TRANSLATION_CACHE is not None:
        return _TRANSLATION_CACHE
    path = Path(__file__).resolve().parent / "data" / "name_translations.json"
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            _TRANSLATION_CACHE = json.load(f)
    else:
        _TRANSLATION_CACHE = {}
    return _TRANSLATION_CACHE


def translate_jp_name(raw_name: str, section: str) -> str:
    if not raw_name:
        return raw_name or ""
    table = _load_translations().get(section, {})
    cn = table.get(raw_name)
    return cn or raw_name


def _region_or_default(region: Optional[str]) -> str:
    region = (region or DEFAULT_REGION).upper()
    if region not in {"JP", "NA", "CN", "KR", "TW"}:
        raise ValueError(f"unsupported region: {region}")
    return region


def export_url(region: str, filename: str) -> str:
    return f"{ATLAS_EXPORT_ROOT.format(region=region)}/{filename}"


def fetch_bytes(url: str, timeout: int = HTTP_TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "FGOBondApp/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _download_range_raw(url: str, start: int, end: int) -> Tuple[bytes, int]:
    """请求一段原始 JSON 字节区间；使用 gzip 压缩传输后解压。"""
    headers = {
        "User-Agent": "FGOBondApp/0.1",
        "Range": f"bytes={start}-{end}",
        "Accept-Encoding": "gzip",
    }
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        if resp.status == 206:
            total_raw = 0
            content_range = resp.headers.get("Content-Range") or ""
            if "/" in content_range:
                total_raw = int(content_range.rsplit("/", 1)[1])
            body = resp.read()
            if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                raw = gzip.decompress(body)
            else:
                raw = body
            return raw, total_raw
        # 服务器不支持 Range 时整包读取
        body = resp.read()
        if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
            raw = gzip.decompress(body)
        else:
            raw = body
        return raw, len(raw)


def download_to_cache(url: str, dest: Path, label: str) -> Path:
    """分段 Range 下载到缓存文件，返回最终文件路径。

    Atlas 大导出文件支持 HTTP Range；且开启 gzip 后每个分段可独立解压。
    经实测 2MiB/段速度最优，避免整包流长时间无数据。
    """
    import time

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(".part")
    if part.exists():
        part.unlink()

    range_size = 2 * 1024 * 1024  # 2 MiB raw per request
    start = 0
    total: Optional[int] = None
    downloaded = 0
    last_percent = -1

    with part.open("wb") as f:
        while True:
            end = start + range_size - 1
            raw, total_raw = _download_range_raw(url, start, end)
            if not raw:
                break
            f.write(raw)
            downloaded += len(raw)
            if total is None and total_raw:
                total = total_raw
            start += len(raw)

            if total:
                percent = downloaded * 100 // total
                if percent != last_percent and percent % 10 == 0:
                    print(
                        f"[data_fetcher] {label}: {percent}% "
                        f"({downloaded / 1024 / 1024:.1f}/{total / 1024 / 1024:.1f} MB)",
                        file=sys.stderr,
                    )
                    last_percent = percent

            if len(raw) < range_size or (total is not None and downloaded >= total):
                break

            # 轻微间隔，避免请求过密被断开
            time.sleep(0.05)

    part.replace(dest)
    print(f"[data_fetcher] {label}: done -> {dest}", file=sys.stderr)
    return dest


def _load_json_cached(
    region: str,
    filename: str,
    cache_dir: Path,
    label: str,
    use_cache: bool,
) -> List[Dict[str, Any]]:
    cache_path = cache_dir / f"{region}_{filename}"
    if use_cache and cache_path.exists():
        with cache_path.open("r", encoding="utf-8") as f:
            return json.load(f)

    url = export_url(region, filename)
    print(f"[data_fetcher] downloading {url}", file=sys.stderr)
    if use_cache:
        download_to_cache(url, cache_path, label)
        with cache_path.open("r", encoding="utf-8") as f:
            return json.load(f)
    else:
        return json.loads(fetch_bytes(url).decode("utf-8"))


def load_nice_servants(
    region: Optional[str] = None,
    use_cache: bool = True,
    cache_dir: Optional[Path | str] = None,
) -> List[Dict[str, Any]]:
    """获取完整 nice servant 列表，优先本地缓存。"""
    region = _region_or_default(region)
    cache_dir = Path(cache_dir or RAW_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return _load_json_cached(region, NICE_SERVANT_FILE, cache_dir, "nice_servant", use_cache)


def load_nice_equips(
    region: Optional[str] = None,
    use_cache: bool = True,
    cache_dir: Optional[Path | str] = None,
) -> List[Dict[str, Any]]:
    """获取完整 nice equip 列表，优先本地缓存。"""
    region = _region_or_default(region)
    cache_dir = Path(cache_dir or RAW_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return _load_json_cached(region, NICE_EQUIP_FILE, cache_dir, "nice_equip", use_cache)


def get_remote_export_meta(
    region: Optional[str] = None,
    filename: str = NICE_SERVANT_FILE,
) -> Dict[str, str]:
    """通过 HEAD 获取 Atlas 导出文件的 ETag/Last-Modified，用于应用内更新检测。"""
    region = _region_or_default(region)
    url = export_url(region, filename)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "FGOBondApp/0.1"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return {
            "etag": resp.headers.get("ETag") or "",
            "last_modified": resp.headers.get("Last-Modified") or "",
        }


# ---------------------------------------------------------------------------
# 从者解析
# ---------------------------------------------------------------------------
def _trait_pairs(traits: Iterable[Dict[str, Any]]) -> List[Tuple[str, Optional[int]]]:
    # “unknown”在 Atlas 里是多个不同 trait id 共用的占位显示名，
    # 不能当作同一种特性匹配，否则会误伤/误全量生效（如迦勒底之人）。
    return [
        (t.get("name", ""), t.get("id"))
        for t in traits
        if t.get("name") and t.get("name") != "unknown"
    ]


def _manual_trait_pairs(servant_id: int, stage: str) -> List[Tuple[str, Optional[int]]]:
    return [(name, None) for name in get_override_traits(servant_id, stage)]


def _global_trait_add_pairs(
    servant: Dict[str, Any],
) -> List[Tuple[str, Optional[int]]]:
    """提取无条件、常驻的 traitAdd 追加特性。

    Atlas 里“兽科”等追加特性经常放在 `traitAdd` 而不是普通 traits /
    ascensionAdd 中。这里只取 `eventId == 0` 的常驻项，避免把活动限时特性
    当作全阶段常驻特性写入。
    """
    result: List[Tuple[str, Optional[int]]] = []
    seen: set = set()
    for entry in servant.get("traitAdd") or []:
        if int(entry.get("eventId") or 0) != 0:
            continue
        for t in entry.get("trait") or []:
            name = t.get("name")
            if not name or name == "unknown":
                continue
            if name in seen:
                continue
            seen.add(name)
            result.append((name, t.get("id")))
    return result


def _apply_attribute_override(
    traits: List[Tuple[str, Optional[int]]],
    attribute_value: Optional[str],
) -> List[Tuple[str, Optional[int]]]:
    """应用 Atlas ascensionAdd.attribute 的属性整体覆盖。

    API 的 ascensionAdd.individuality 列表里仍保留基础属性 trait，
    但 attribute.ascension 表示该阶段属性整体变为另一值（如星→人），
    因此需要把旧的 attribute* trait 移除并替换成目标 trait。
    """
    if not attribute_value:
        return traits
    new_name = ATTRIBUTE_VALUE_TO_TRAIT.get(str(attribute_value).lower())
    if not new_name:
        return traits
    result = [(name, tid) for name, tid in traits if name not in ATTRIBUTE_TRAIT_NAMES]
    names = {name for name, _ in result}
    if new_name not in names:
        result.append((new_name, None))
    return result


def resolve_stage_trait_sets(
    servant: Dict[str, Any],
) -> Dict[str, List[Tuple[str, Optional[int]]]]:
    """计算该从者五个灵基阶段的特性集合。

    策略
    ----
    1. Atlas `ascensionAdd.individuality.ascension` 若某阶段给出非空列表，
       视为该阶段的完整特性（已含阶级/性别/属性等基础项）。
    2. 若为空（API 表示该阶段无额外变化），回退到 servant.traits 公共特性。
    3. 叠加任务书硬编码映射中的差异项，保证文档中已知从者一定覆盖。
    """
    servant_id = int(servant["id"])
    base_traits = _trait_pairs(servant.get("traits") or [])
    base_names = {name for name, _ in base_traits}

    ascension_add = (
        (servant.get("ascensionAdd") or {}).get("individuality") or {}
    ).get("ascension") or {}
    attribute_asc = (
        ((servant.get("ascensionAdd") or {}).get("attribute") or {})
        .get("ascension") or {}
    )

    result: Dict[str, List[Tuple[str, Optional[int]]]] = {}
    global_add = _global_trait_add_pairs(servant)
    for stage, asc_key in zip(STAGES, ASCENSION_KEYS):
        raw = ascension_add.get(asc_key) or []
        if raw:
            # API 已有该阶段的完整特性列表，以 API 为准；
            # 任务书映射主要作为 API 缺失/为空时的兜底。
            traits = _trait_pairs(raw)
        else:
            traits = list(base_traits)
            # 补丁：仅在 API 未给出该阶段完整列表时，叠加文档映射差异项
            names = {name for name, _ in traits}
            for name, tid in _manual_trait_pairs(servant_id, stage):
                if name not in names:
                    traits.append((name, tid))
                    names.add(name)

        # 叠加常驻 traitAdd（例如“兽科”常以追加特性形式存在）
        names = {name for name, _ in traits}
        for name, tid in global_add:
            if name not in names:
                traits.append((name, tid))
                names.add(name)

        # 应用 Atlas ascensionAdd.attribute 的属性整体覆盖（如星→人）
        traits = _apply_attribute_override(traits, attribute_asc.get(asc_key))

        # 排序便于稳定输出
        result[stage] = sorted(traits, key=lambda x: x[0])
    return result


def resolve_costume_trait_sets(
    servant: Dict[str, Any],
) -> Dict[int, List[Tuple[str, Optional[int]]]]:
    """计算该从者所有灵衣（costume）状态的完整特性集合。

    Atlas nice 数据中 `ascensionAdd.individuality.costume` 的值是完整特性列表，
    属于“灵衣状态”而不是普通再临阶段。灵衣作为再临阶段拿不到目标特性时的
    兜底状态，不参与再临阶段的优先级展示。
    """
    ascension_add = (
        (servant.get("ascensionAdd") or {}).get("individuality") or {}
    )
    costume_map = ascension_add.get("costume") or {}
    attribute_costume = (
        ((servant.get("ascensionAdd") or {}).get("attribute") or {})
        .get("costume") or {}
    )
    global_add = _global_trait_add_pairs(servant)
    result: Dict[int, List[Tuple[str, Optional[int]]]] = {}
    for costume_id, raw in costume_map.items():
        traits = _trait_pairs(raw or [])
        names = {name for name, _ in traits}
        for name, tid in global_add:
            if name not in names:
                traits.append((name, tid))
                names.add(name)
        traits = _apply_attribute_override(
            traits, attribute_costume.get(str(costume_id))
        )
        if traits:
            result[int(costume_id)] = sorted(traits, key=lambda x: x[0])
    return result


def parse_servant(servant: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """把 API nice servant 对象转成 DB 行结构；非玩家可用从者返回 None。"""
    if servant.get("type") not in PLAYABLE_SERVANT_TYPES:
        return None
    raw_name = servant.get("name") or ""
    raw_original = servant.get("originalName") or ""
    return {
        "id": int(servant["id"]),
        "collection_no": int(servant.get("collectionNo") or 0),
        "name": translate_jp_name(raw_name, "svt_names"),
        "original_name": raw_original or raw_name,
        "class": servant.get("className") or "",
        "cost": int(servant.get("cost") or 0),
        "rarity": servant.get("rarity"),
        "atk_max": servant.get("atkMax"),
        "hp_max": servant.get("hpMax"),
        "type": servant.get("type") or "",
    }


# ---------------------------------------------------------------------------
# 礼装解析（重点：牵绊加成礼装识别）
# ---------------------------------------------------------------------------
def _condition_groups(func: Dict[str, Any]) -> List[List[str]]:
    """从技能 function 提取特性触发条件。

    返回 `[[traitA, traitB], ...]`，其中每组表示“同时满足”；
    多个组在计算阶段按 API 语义处理。
    """
    groups: List[List[str]] = []
    functvals = func.get("functvals") or []
    if functvals:
        # functvals 中的多个 trait 通常是“或”关系（如“星之力或恶”），
        # 每个 trait 单独成一组；组间在计算阶段按“任一组成立即可”处理。
        groups.extend(
            [[t.get("name", "")] for t in functvals if t.get("name") and t.get("name") != "unknown"]
        )
        return groups

    overwrite = func.get("overWriteTvalsList") or []
    if not overwrite:
        overwrite = (func.get("script") or {}).get("overwriteTvals") or []
    for group in overwrite:
        if isinstance(group, list):
            names = [t.get("name", "") for t in group if t.get("name") and t.get("name") != "unknown"]
            if names:
                groups.append(names)
    return groups


def _rate_from_svals(func: Dict[str, Any]) -> Tuple[float, float]:
    """返回 (普通加成RateCount, 助战加成RateCount)。"""
    normal = 0.0
    follower = 0.0
    svals = func.get("svals") or []
    if svals:
        normal = float(svals[0].get("RateCount") or 0)
    follower_vals = func.get("followerVals") or []
    if follower_vals:
        follower = float(follower_vals[0].get("RateCount") or 0)
    return normal, follower


def parse_bond_effect(equip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """解析一张装备是否为牵绊加成礼装，并返回加成描述。

    只使用“最大解放/最大效果”的技能版本（strengthStatus=99 或 RateCount 最大者）。
    """
    best: Optional[Dict[str, Any]] = None
    best_normal_rate = -1.0
    best_skill_detail = ""

    for skill in equip.get("skills") or []:
        for func in skill.get("functions") or []:
            if func.get("funcType") != "servantFriendshipUp":
                continue
            normal_rate, _follower = _rate_from_svals(func)
            if normal_rate <= 0 and _follower <= 0:
                continue
            if normal_rate > best_normal_rate or best is None:
                best = func
                best_normal_rate = normal_rate
                best_skill_detail = translate_jp_name(skill.get("detail") or "", "skill_detail")

    if best is None:
        return None

    normal_rate, follower_rate = _rate_from_svals(best)
    condition_groups = _condition_groups(best)
    # RateCount 单位是 0.1%，转成小数：20 -> 2% -> 0.02
    normal_bonus = normal_rate / 1000.0
    follower_bonus = follower_rate / 1000.0

    if condition_groups:
        bonus_type = "trait"
    elif normal_bonus <= 0 and follower_bonus > 0:
        bonus_type = "support_only"
    else:
        bonus_type = "universal"

    return {
        "bonus_type": bonus_type,
        "bonus_value": normal_bonus,
        "support_bonus": follower_bonus,
        "trigger_traits_json": json.dumps(condition_groups, ensure_ascii=False),
        "detail": best_skill_detail,
        "is_bond_ce": 1,
    }


def _is_event_limited_detail(detail: Optional[str]) -> bool:
    if not detail:
        return False
    low = detail.lower()
    return any(
        marker in low
        for marker in ("活动限定", "event only", "event limited", "イベント限定")
    )


def parse_craft(equip: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """把 API nice equip 对象转成 DB 行结构；非礼装返回 None。"""
    if equip.get("type") not in CRAFT_EQUIP_TYPES:
        return None
    effect = parse_bond_effect(equip)
    detail = effect.get("detail") if effect else None
    raw_name = equip.get("name") or ""
    raw_original = equip.get("originalName") or ""
    base = {
        "id": int(equip["id"]),
        "collection_no": equip.get("collectionNo"),
        "name": translate_jp_name(raw_name, "ce_names"),
        "original_name": raw_original or raw_name,
        "cost": int(equip.get("cost") or 0),
        "rarity": equip.get("rarity"),
        "bonus_type": None,
        "bonus_value": None,
        "support_bonus": None,
        "trigger_traits_json": json.dumps([], ensure_ascii=False),
        "detail": detail,
        "is_bond_ce": 0,
        "is_event_limited": 1 if _is_event_limited_detail(detail) else 0,
    }
    if effect:
        base.update(effect)
    return base


# ---------------------------------------------------------------------------
# 构建数据库
# ---------------------------------------------------------------------------
def _cn_unavailable_bond_ce_ids(
    conn: sqlite3.Connection,
    cn_equips: List[Dict[str, Any]],
) -> List[int]:
    """对比当前 DB（JP 全量）与简中服礼装，找出简中服尚未实装的可选牵绊礼装 ID。

    只处理 is_bond_ce = 1 的礼装，不扩展到全部礼装/从者。
    """
    cn_ids = {int(e.get("id")) for e in cn_equips}
    rows = conn.execute(
        "SELECT id FROM crafts WHERE is_bond_ce = 1"
    ).fetchall()
    return sorted(int(r["id"]) for r in rows if int(r["id"]) not in cn_ids)


def build_database(
    region: Optional[str] = None,
    db_path: Optional[Path | str] = None,
    use_cache: bool = True,
    keep_user_data: bool = True,
    progress: Optional[Any] = None,
) -> Dict[str, int]:
    """全量从 Atlas API 拉取并构建 SQLite 数据库。

    返回统计信息 dict。
    """
    region = _region_or_default(region)
    conn = database.connect(db_path)
    database.init_db(conn)

    if progress:
        progress("正在下载从者数据...")
    servants_api = load_nice_servants(region, use_cache=use_cache)

    if progress:
        progress("正在下载礼装数据...")
    equips_api = load_nice_equips(region, use_cache=use_cache)

    # 两份数据都下载/解析成功后再清空旧数据，避免下载失败时把本地可用库清掉
    database.clear_data_tables(conn)

    if progress:
        progress("正在写入从者与特性数据...")

    servant_count = 0
    stage_trait_count = 0
    craft_count = 0
    bond_ce_count = 0

    for raw in servants_api:
        parsed = parse_servant(raw)
        if parsed is None:
            continue
        database.upsert_servant(conn, parsed)
        servant_count += 1
        stage_traits = resolve_stage_trait_sets(raw)
        for stage, traits in stage_traits.items():
            database.upsert_stage_traits(conn, parsed["id"], stage, traits)
            stage_trait_count += len(traits)
        costume_traits = resolve_costume_trait_sets(raw)
        for costume_id, traits in costume_traits.items():
            database.upsert_costume_traits(conn, parsed["id"], costume_id, traits)

    # JP 全量作为主库时，额外写入简中服 traits，供“日服/简中服”切换后按服务器取数。
    if region != "CN":
        if progress:
            progress("正在写入简中服特性数据...")
        try:
            cn_servants_api = load_nice_servants("CN", use_cache=use_cache)
            for raw in cn_servants_api:
                parsed = parse_servant(raw)
                if parsed is None:
                    continue
                stage_traits = resolve_stage_trait_sets(raw)
                for stage, traits in stage_traits.items():
                    database.upsert_stage_traits_cn(conn, parsed["id"], stage, traits)
                costume_traits = resolve_costume_trait_sets(raw)
                for costume_id, traits in costume_traits.items():
                    database.upsert_costume_traits_cn(conn, parsed["id"], costume_id, traits)
        except Exception as exc:
            # CN traits 只是日服模式的辅助数据，失败不阻断主数据更新
            if progress:
                progress(f"警告：无法写入简中服特性数据（{exc}）")

    if progress:
        progress("正在写入礼装数据...")

    for raw in equips_api:
        parsed = parse_craft(raw)
        if parsed is None:
            continue
        database.upsert_craft(conn, parsed)
        craft_count += 1
        if parsed["is_bond_ce"]:
            bond_ce_count += 1

    # 记录简中服尚未实装的可选牵绊礼装 ID：
    # JP 全量库与 CN nice_equip 对比，仅针对 is_bond_ce=1 的礼装。
    cn_unavailable_ids: List[int] = []
    old_cn_unavailable_raw = database.get_meta(conn, "cn_unavailable_bond_ce_ids")
    try:
        if region == "CN":
            cn_unavailable_ids = []
            database.set_meta(conn, "cn_equip_etag", "")
        else:
            cn_equips = load_nice_equips("CN", use_cache=use_cache)
            cn_unavailable_ids = _cn_unavailable_bond_ce_ids(conn, cn_equips)
            try:
                cn_meta = get_remote_export_meta("CN", NICE_EQUIP_FILE)
                database.set_meta(conn, "cn_equip_etag", cn_meta["etag"])
            except Exception:
                pass
    except Exception as exc:
        # CN 对比失败不应阻断主数据更新；尽量沿用上一次的可用列表。
        try:
            cn_unavailable_ids = json.loads(old_cn_unavailable_raw or "[]")
        except Exception:
            cn_unavailable_ids = []
        if progress:
            progress(f"警告：无法获取简中服礼装数据，暂用上次的国服未实装列表（{exc}）")
    database.set_meta(
        conn,
        "cn_unavailable_bond_ce_ids",
        json.dumps(cn_unavailable_ids, ensure_ascii=False),
    )

    # 记录数据版本信息，供应用内“检查更新/更新数据”使用
    try:
        remote_meta = get_remote_export_meta(region)
    except Exception:
        remote_meta = {"etag": "", "last_modified": ""}

    database.set_meta(conn, "data_region", region)
    database.set_meta(conn, "servant_etag", remote_meta["etag"])
    database.set_meta(conn, "servant_last_modified", remote_meta["last_modified"])
    database.set_meta(
        conn,
        "updated_at",
        __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    )
    conn.commit()
    conn.close()

    stats = {
        "region": region,
        "servants": servant_count,
        "stage_trait_rows": stage_trait_count,
        "crafts": craft_count,
        "bond_ces": bond_ce_count,
        "cn_unavailable_bond_ces": len(cn_unavailable_ids),
    }
    return stats


def refresh_costume_names(
    region: Optional[str] = None,
    db_path: Optional[Path | str] = None,
    progress: Optional[Any] = None,
) -> Dict[str, Any]:
    """增量刷新灵衣中文名。

    数据源使用 Atlas Academy 的 CN raw 从者小接口（单从者一次请求），
    只请求本地 DB 中已出现灵衣的从者，不下载整包 lore。
    """
    import time as _time

    region = _region_or_default(region)
    conn = database.connect(db_path)
    database.init_db(conn)
    pairs = conn.execute(
        "SELECT DISTINCT servant_id, costume_id FROM servant_costume_traits ORDER BY servant_id, costume_id"
    ).fetchall()
    servant_ids = sorted({int(r["servant_id"]) for r in pairs})
    wanted = {(int(r["servant_id"]), int(r["costume_id"])) for r in pairs}

    updated = 0
    errors = 0
    total_bytes = 0
    for idx, sid in enumerate(servant_ids, start=1):
        if progress:
            progress(f"正在更新灵衣名称 {idx}/{len(servant_ids)}...")
        url = f"https://api.atlas.chaldea.center/raw/{region}/servant/{sid}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Chaldea/2.5"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            total_bytes += len(raw)
            data = json.loads(raw)
            extra = data.get("mstSvtExtra") or {}
            id_map = extra.get("costumeLimitSvtIdMap") or {}
            by_chara = {}
            for ent in id_map.values():
                if isinstance(ent, dict) and ent.get("battleCharaId"):
                    by_chara[int(ent["battleCharaId"])] = ent
            for costume_id in [cid for s, cid in wanted if s == sid]:
                ent = by_chara.get(costume_id)
                if ent:
                    raw_name = (ent.get("shortName") or ent.get("name") or "").strip()
                    # JP raw 返回日文名，套 Chaldea costume_names 转中文
                    name = translate_jp_name(raw_name, "costume_names")
                    database.upsert_costume_name(conn, sid, costume_id, name)
                    if name:
                        updated += 1
        except Exception:
            errors += 1
        _time.sleep(0.1)

    conn.commit()
    conn.close()
    return {
        "costume_names": updated,
        "costume_name_servants": len(servant_ids),
        "costume_name_bytes": total_bytes,
        "costume_name_errors": errors,
    }


def update_database(
    region: Optional[str] = None,
    db_path: Optional[Path | str] = None,
    force: bool = False,
    use_cache: bool = True,
    progress: Optional[Any] = None,
) -> Dict[str, Any]:
    """应用内“更新数据”入口。

    先 HEAD 远程 ETag；若本地已是最新且未强制更新，则直接返回 no_change。
    否则执行全量重建。重建只清空 servants/servant_stage_traits/crafts，
    user_box/user_teams 不会被改动，因此新从者/新礼装可平滑加入。
    """
    region = _region_or_default(region)
    if progress:
        progress("正在检查数据更新...")
    conn = database.connect(db_path)
    database.init_db(conn)
    local_etag = database.get_meta(conn, "servant_etag")
    local_cn_equip_etag = database.get_meta(conn, "cn_equip_etag")
    conn.close()

    remote_meta = get_remote_export_meta(region)
    cn_remote_meta: Dict[str, str] = {"etag": "", "last_modified": ""}
    if region != "CN":
        try:
            cn_remote_meta = get_remote_export_meta("CN", NICE_EQUIP_FILE)
        except Exception:
            cn_remote_meta = {"etag": "", "last_modified": ""}
    cn_changed = bool(
        region != "CN"
        and cn_remote_meta["etag"]
        and local_cn_equip_etag != cn_remote_meta["etag"]
    )
    if (
        not force
        and not cn_changed
        and local_etag
        and remote_meta["etag"]
        and local_etag == remote_meta["etag"]
    ):
        if progress:
            progress("数据已是最新版本")
        return {
            "status": "no_change",
            "updated": False,
            "region": region,
            "message": "数据已经是最新版本",
        }

    stats = build_database(
        region=region,
        db_path=db_path,
        use_cache=use_cache,
        progress=progress,
    )
    try:
        name_stats = refresh_costume_names(
            region=region,
            db_path=db_path,
            progress=progress,
        )
        stats.update(name_stats)
    except Exception as e:
        stats["costume_name_error"] = str(e)
    try:
        from . import event_bonus
        event_stats = event_bonus.update_event_bond_bonus(
            region=region,
            db_path=db_path,
            use_cache=use_cache,
            progress=progress,
        )
        stats.update(event_stats)
    except Exception as e:
        stats["event_bonus_error"] = str(e)
    if progress:
        progress("数据更新完成")
    stats["status"] = "success"
    stats["updated"] = True
    return stats


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Build/update FGO local SQLite database")
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--db", default=str(database.DB_PATH))
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--update", action="store_true", help="应用内更新模式：检测 ETag，变化才重建")
    parser.add_argument("--force", action="store_true", help="强制更新/重建，即使 ETag 未变化")
    args = parser.parse_args()
    if args.update:
        stats = update_database(
            region=args.region,
            db_path=args.db,
            force=args.force,
            use_cache=not args.no_cache,
        )
    else:
        stats = build_database(
            region=args.region,
            db_path=args.db,
            use_cache=not args.no_cache,
        )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
