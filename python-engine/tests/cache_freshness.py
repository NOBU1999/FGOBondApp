# -*- coding: utf-8 -*-
"""本地缓存新鲜度判定的离线单测（秒级、不联网）。

为什么要有它
------------
2026-10-08 查实的一个真问题：`_load_json_cached()` 原来是"缓存文件存在就直接用"，
只有文件缺失才下载；而「更新数据」固定 `use_cache=True`，缓存又从来不会被刷新
→ **第一次下载之后，以后每次点「更新数据」都只是拿旧快照重建一遍**，
新从者 / 新礼装 / 新活动永远进不来（用户实测：活动牵绊加成表停在 9/20 那版，
9/16 的新活动一直不出现）。

现在改成：**远端 Last-Modified 比缓存文件新 ⇒ 判定过期，重新下载**；
拿不准（网络失败 / 没有 Last-Modified）时继续用缓存（宁可先用旧的，也别让更新整个失败）。

跑法
----
    cd FGOBondApp
    python python-engine/tests/cache_freshness.py
"""
import email.utils
import json
import os
import sys
import tempfile
import time
from pathlib import Path

try:  # Windows 控制台默认 GBK
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python-engine"))

from engine import data_fetcher  # noqa: E402

FAILED = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("  ✅ " if ok else "  ❌ ") + name + ((" ｜ " + detail) if detail else ""))
    if not ok:
        FAILED.append(name)


def http_date(ts: float) -> str:
    return email.utils.formatdate(ts, usegmt=True)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="cache-freshness-"))
    cache_dir = tmp / "raw"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "JP_nice_servant.json"

    downloads = []

    # 打桩：不联网。export_url 给个假地址；download_to_cache 写一份"新数据"
    data_fetcher.export_url = lambda region, filename: f"http://stub/{region}/{filename}"

    def fake_download(url, dest, label):
        downloads.append(label)
        dest.write_text(json.dumps([{"id": 1, "name": "NEW"}]), encoding="utf-8")
        return dest

    data_fetcher.download_to_cache = fake_download

    now = time.time()

    # ---- 1) 缓存比远端新 → 用缓存，不下载 ----
    cache_file.write_text(json.dumps([{"id": 1, "name": "CACHED"}]), encoding="utf-8")
    os.utime(cache_file, (now, now))
    data_fetcher.get_remote_export_meta = lambda *a, **k: {
        "etag": "e-old",
        "last_modified": http_date(now - 3600),
    }
    data = data_fetcher._load_json_cached("JP", "nice_servant.json", cache_dir, "nice_servant", True)
    check("缓存比远端新 → 直接用缓存", data[0]["name"] == "CACHED", "downloads=%d" % len(downloads))

    # ---- 2) 远端比缓存新 → 判定过期，重新下载 ----
    downloads.clear()
    data_fetcher.get_remote_export_meta = lambda *a, **k: {
        "etag": "e-new",
        "last_modified": http_date(now + 3600),
    }
    data = data_fetcher._load_json_cached("JP", "nice_servant.json", cache_dir, "nice_servant", True)
    check("远端比缓存新 → 重新下载", data[0]["name"] == "NEW" and len(downloads) == 1,
          "downloads=%d" % len(downloads))
    check("重新下载后缓存被覆盖", json.loads(cache_file.read_text(encoding="utf-8"))[0]["name"] == "NEW")

    # ---- 3) 网络失败（拿不到远端信息）→ 继续用缓存 ----
    downloads.clear()
    cache_file.write_text(json.dumps([{"id": 1, "name": "CACHED"}] ), encoding="utf-8")
    os.utime(cache_file, (now, now))

    def boom(*a, **k):
        raise OSError("network down")

    data_fetcher.get_remote_export_meta = boom
    data = data_fetcher._load_json_cached("JP", "nice_servant.json", cache_dir, "nice_servant", True)
    check("网络失败 → 继续用缓存（不让更新挂掉）", data[0]["name"] == "CACHED" and not downloads)

    # ---- 4) 远端没给 Last-Modified → 继续用缓存 ----
    data_fetcher.get_remote_export_meta = lambda *a, **k: {"etag": "e", "last_modified": ""}
    data = data_fetcher._load_json_cached("JP", "nice_servant.json", cache_dir, "nice_servant", True)
    check("没有 Last-Modified → 继续用缓存", data[0]["name"] == "CACHED" and not downloads)

    # ---- 5) 缓存文件不存在 → 下载 ----
    downloads.clear()
    cache_file.unlink()
    data = data_fetcher._load_json_cached("JP", "nice_servant.json", cache_dir, "nice_servant", True)
    check("缓存不存在 → 下载", data[0]["name"] == "NEW" and len(downloads) == 1)

    print()
    if FAILED:
        print("❌ 失败 %d 项：%s" % (len(FAILED), "；".join(FAILED)))
        return 1
    print("✅ 缓存新鲜度判定全部通过（6/6）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
