#!/usr/bin/env python3
"""生成引擎用中文翻译文件（data/name_translations.json）。

取数默认**联网**，不要求本机装过 Chaldea：
1. 从 chaldea-data 仓库的 `mappings/*.json` 拉取（按类别拆好的单个文件）；
2. 网络失败且本机确实有 Chaldea 数据时，退回读本机 mappingData（方便本地开发）；
3. 两边都拿不到 → 保留现有表（不会写空表）。

输出：
- data/name_translations.json
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Dict

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "name_translations.json"
NICE_TRAIT = "https://api.atlasacademy.io/export/CN/nice_trait.json"

SECTIONS = ("svt_names", "ce_names", "costume_names", "event_names", "trait", "skill_detail")

# 社区译名数据（六个 section 一一对应，单文件，无需跨文件合并）
ONLINE_BASE = "https://raw.githubusercontent.com/chaldea-center/chaldea-data/main/mappings/"
ONLINE_MIRROR = "https://cdn.jsdelivr.net/gh/chaldea-center/chaldea-data@main/mappings/"


def chaldea_game_dir() -> Path:
    """Chaldea 本地数据目录，可用环境变量 CHALDEA_GAME_DIR 覆盖。"""
    env = os.environ.get("CHALDEA_GAME_DIR")
    if env:
        return Path(env)
    return Path.home() / "chaldea" / "userdata" / "game"


def local_mapping_paths() -> list:
    game = chaldea_game_dir()
    return [
        game / "mappingData.1.json",
        game / "mappingData.3.json",
        game / "mappingPatch.json",
    ]


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "FGOBondApp/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_cn(table: Dict[str, dict]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for key, langs in table.items():
        if isinstance(langs, dict):
            val = langs.get("CN") or langs.get("JP") or langs.get("TW") or langs.get("NA")
            if val:
                out[str(key)] = val
    return out


def load_local_sections() -> Dict[str, Dict[str, str]]:
    """把几份 mapping 文件**先按 key 合并多语言字典**，再取值。

    为什么不能像以前那样"逐个文件 extract 再 update"：同一个名字会在多个文件里各出现一次，
    后面的补丁文件常常只带 NA/TW（没有 CN）——那样更新会把前面文件里**正确的中文**覆盖成英文，
    界面上就变成"应该翻译的名字却显示英文"（2026-11-13 用户反馈）。
    """
    merged: Dict[str, Dict[str, Dict[str, str]]] = {s: {} for s in SECTIONS}
    for path in local_mapping_paths():
        if not path.exists():
            print(f"[skip] 本地不存在: {path}", file=sys.stderr)
            continue
        print(f"[load] {path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        for section in SECTIONS:
            for key, langs in (data.get(section) or {}).items():
                if isinstance(langs, dict):
                    slot = merged[section].setdefault(str(key), {})
                    slot.update({k: v for k, v in langs.items() if v})

    result: Dict[str, Dict[str, str]] = {s: {} for s in SECTIONS}
    fallback_keys: Dict[str, Dict[str, str]] = {s: {} for s in SECTIONS}
    for section, table in merged.items():
        for key, langs in table.items():
            cn = langs.get("CN")
            if cn:
                result[section][key] = cn
                continue
            # 没有官方简中：先放一个 JP/TW/NA 兜底，稍后用旧表里的中文覆盖回去
            fallback = langs.get("JP") or langs.get("TW") or langs.get("NA")
            if fallback:
                result[section][key] = fallback
                fallback_keys[section][key] = fallback
    return result, fallback_keys


def pick_section(table: Dict[str, dict]):
    """把 {key: {CN/JP/TW/NA}} 压成 {key: 中文}；没有中文的另记进 fallback（稍后用旧表覆盖）。"""
    out: Dict[str, str] = {}
    fallback: Dict[str, str] = {}
    for key, langs in (table or {}).items():
        if not isinstance(langs, dict):
            continue
        cn = langs.get("CN")
        if cn:
            out[str(key)] = cn
            continue
        fb = langs.get("JP") or langs.get("TW") or langs.get("NA")
        if fb:
            out[str(key)] = fb
            fallback[str(key)] = fb
    return out, fallback


def load_online_sections():
    """从 chaldea-data 仓库拉六个 section（不依赖本机装过 Chaldea）。"""
    result: Dict[str, Dict[str, str]] = {s: {} for s in SECTIONS}
    fallback_keys: Dict[str, Dict[str, str]] = {s: {} for s in SECTIONS}
    ok = 0
    for section in SECTIONS:
        name = f"{section}.json"
        table = None
        for base, label in ((ONLINE_BASE, "直连"), (ONLINE_MIRROR, "镜像")):
            try:
                table = fetch_json(base + name)
                break
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {label}拉取 {name} 失败：{exc}", file=sys.stderr)
        if table is None:
            print(f"[warn] {name} 两处都没取到，该节沿用旧表", file=sys.stderr)
            continue
        picked, fb = pick_section(table)
        result[section] = picked
        fallback_keys[section] = fb
        ok += 1
        print(f"[online] {name} → {len(picked)} 条")
    return result, fallback_keys, ok


def load_sections(force_local: bool = False):
    """默认联网；联网整体失败才退回本机 Chaldea 数据。"""
    if not force_local:
        result, fallback, ok = load_online_sections()
        if ok > 0:
            return result, fallback
        print("[warn] 联网数据一条都没拿到 → 改用本机 Chaldea 数据", file=sys.stderr)
    result, fallback = load_local_sections()
    if not any(result.values()):
        print("[warn] 本机也没有可用的 Chaldea 数据；只保留旧表内容", file=sys.stderr)
    return result, fallback


def merge_existing(new_sections: Dict[str, Dict[str, str]], fallback_keys: Dict[str, Dict[str, str]]) -> Dict[str, Dict[str, str]]:
    """旧表里已有的中文优先于新算出来的 JP/TW/NA 兜底值；新 key 才用兜底。"""
    if not OUT.exists():
        return new_sections
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] 旧表读取失败，跳过合并：{exc}", file=sys.stderr)
        return new_sections
    kept = 0
    # 某一节这次完全没取到（网络失败）→ 整节沿用旧表，别写空
    for section in list(new_sections):
        if new_sections[section]:
            continue
        old_table = old.get(section) or {}
        if old_table:
            new_sections[section] = dict(old_table)
            print(f"[keep] {section} 本次没取到，沿用旧表 {len(old_table)} 条", file=sys.stderr)
    for section, keys in fallback_keys.items():
        old_table = old.get(section) or {}
        for key in keys:
            old_val = old_table.get(key)
            if old_val:
                new_sections[section][key] = old_val
                kept += 1
    if kept:
        print(f"[merge] 旧表里的中文覆盖回兜底值 {kept} 条")
    # 另外：新值里还留着未替换的占位符（[servantName 106400] 这类，来源数据没做替换），
    # 而旧表那条是好的 ⇒ 留旧值，别让界面显示占位符。
    PLACEHOLDER = re.compile(r"\[servant(Name|Id)\b")
    rescued = 0
    for section, table in new_sections.items():
        old_table = old.get(section) or {}
        for key, val in list(table.items()):
            if not isinstance(val, str) or not PLACEHOLDER.search(val):
                continue
            old_val = old_table.get(key)
            if isinstance(old_val, str) and old_val and not PLACEHOLDER.search(old_val):
                table[key] = old_val
                rescued += 1
    if rescued:
        print(f"[merge] 新值带未替换占位符、沿用旧值 {rescued} 条")
    return new_sections


def main() -> int:
    force_local = "--local" in sys.argv[1:]
    sections, fallback_keys = load_sections(force_local)
    sections = merge_existing(sections, fallback_keys)
    print("[info] 下载 nice_trait.json 建立 trait id -> machine ...")
    try:
        nice_trait = fetch_json(NICE_TRAIT)
    except Exception as exc:
        print(f"[warn] nice_trait 下载失败：{exc}；trait_names 留空", file=sys.stderr)
        nice_trait = {}

    id_to_machine = {str(k): v for k, v in nice_trait.items()}
    trait_machine_to_cn: Dict[str, str] = {}
    for tid, machine in id_to_machine.items():
        cn = sections.get("trait", {}).get(str(tid))
        if cn:
            trait_machine_to_cn[machine] = cn
    # 下载失败时不要把旧表里的 trait_names 抹掉（离线/被墙时也照旧可用）
    if not trait_machine_to_cn and OUT.exists():
        try:
            old_trait = json.loads(OUT.read_text(encoding="utf-8")).get("trait_names") or {}
        except Exception:  # noqa: BLE001
            old_trait = {}
        if old_trait:
            trait_machine_to_cn = old_trait
            print(f"[keep] nice_trait 拿不到，沿用旧表的 trait_names {len(old_trait)} 条", file=sys.stderr)

    data = {
        "svt_names": sections["svt_names"],
        "ce_names": sections["ce_names"],
        "costume_names": sections["costume_names"],
        "event_names": sections["event_names"],
        "trait_names": trait_machine_to_cn,
        "skill_detail": sections["skill_detail"],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[done] 已写入 {OUT} ({OUT.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
