#!/usr/bin/env python3
"""生成引擎用中文翻译文件。

优先从本地 Chaldea mappingData 生成；如果本机没有 Chaldea 数据，
可改为从 chaldea-data GitHub 拉取（网络允许时）。

输出：
- python-engine/engine/data/name_translations.json
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Dict

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "python-engine" / "engine" / "data" / "name_translations.json"
NICE_TRAIT = "https://api.atlasacademy.io/export/CN/nice_trait.json"

SECTIONS = ("svt_names", "ce_names", "costume_names", "event_names", "trait", "skill_detail")


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
    result = {s: {} for s in SECTIONS}
    for path in local_mapping_paths():
        if not path.exists():
            print(f"[skip] 本地不存在: {path}", file=sys.stderr)
            continue
        print(f"[load] {path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        for section in SECTIONS:
            table = data.get(section) or {}
            result[section].update(extract_cn(table))
    return result


def main() -> int:
    sections = load_local_sections()
    print("[info] 下载 nice_trait.json 建立 trait id -> machine ...")
    try:
        nice_trait = fetch_json(NICE_TRAIT)
    except Exception as exc:
        print(f"[warn] nice_trait 下载失败：{exc}；trait_names 将留空", file=sys.stderr)
        nice_trait = {}

    id_to_machine = {str(k): v for k, v in nice_trait.items()}
    trait_machine_to_cn: Dict[str, str] = {}
    for tid, machine in id_to_machine.items():
        cn = sections.get("trait", {}).get(str(tid))
        if cn:
            trait_machine_to_cn[machine] = cn

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
