#!/usr/bin/env python3
"""从本地 Chaldea mappingData 生成 FGO trait 中文名映射。

数据来源：
- trait ID -> 机器名：Atlas/Chaldea nice_trait.json（在线）
- trait ID -> CN 中文：本地 Chaldea userdata/game/mappingData.*.json / mappingPatch.json

输出：
- renderer/data/trait_names.json（原始映射）
- renderer/data/trait_names.js（供前端直接加载）
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Dict

ROOT = Path(__file__).resolve().parents[1]
NICE_TRAIT_URL = "https://api.atlasacademy.io/export/CN/nice_trait.json"
OUT_JSON = ROOT / "renderer" / "data" / "trait_names.json"
OUT_JS = ROOT / "renderer" / "data" / "trait_names.js"


def chaldea_game_dir() -> Path:
    """Chaldea 本地数据目录，可用环境变量 CHALDEA_GAME_DIR 覆盖。"""
    env = os.environ.get("CHALDEA_GAME_DIR")
    if env:
        return Path(env)
    return Path.home() / "chaldea" / "userdata" / "game"


def mapping_paths() -> list:
    game = chaldea_game_dir()
    return [game / "mappingData.3.json", game / "mappingPatch.json"]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "FGOBondApp/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def collect_trait_cn() -> Dict[str, str]:
    """返回 trait_id(str) -> CN 名。"""
    cn: Dict[str, str] = {}
    paths = mapping_paths()
    for p in paths:
        if not p.exists():
            print(f"[skip] {p} 不存在", file=sys.stderr)
            continue
        data = load_json(p)
        for section in ("trait", "event_trait", "field_trait"):
            table = data.get(section) or {}
            for tid, langs in table.items():
                if isinstance(langs, dict):
                    val = langs.get("CN") or langs.get("JP") or langs.get("TW") or langs.get("NA")
                    if val:
                        cn[str(tid)] = val
    return cn


def main() -> int:
    print("[info] 拉取 nice_trait.json ...")
    nice = fetch_json(NICE_TRAIT_URL)
    id_to_machine = {str(k): v for k, v in nice.items()}
    print("[info] 读取本地 Chaldea mappingData ...")
    cn_by_id = collect_trait_cn()

    machine_to_cn: Dict[str, str] = {}
    for tid, machine in id_to_machine.items():
        if tid in cn_by_id:
            machine_to_cn[machine] = cn_by_id[tid]
    # 部分 machine 名在 nice_trait 中缺失但本地有，保留原 id 键不合适；忽略。
    print(f"[info] 映射完成：{len(machine_to_cn)} 条")

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(machine_to_cn, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with OUT_JS.open("w", encoding="utf-8") as f:
        f.write("// 由 scripts/generate_trait_names.py 生成，请勿手改\n")
        f.write("window.TRAIT_NAMES = ")
        json.dump(machine_to_cn, f, ensure_ascii=False)
        f.write(";\n")
    print(f"[done] 已写入:\n  {OUT_JSON}\n  {OUT_JS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
