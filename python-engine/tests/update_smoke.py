# -*- coding: utf-8 -*-
"""「更新数据」这条路的离线烟测（秒级、不联网）。

为什么要有它
------------
v0.1.15 的真机反馈：
    Error invoking remote method 'engine:update': Error: name '_safe_remote_meta' is not defined
原因：那个辅助函数只定义在 check_update() 里，却被 update_database() 调用。
这条路径平时没人走（只有用户点「更新数据」才进），单测/契约都没覆盖 → 一直没暴露。
所以这里专门把整条 update_database 跑完（离线），任何 NameError / 拼写错误都会当场炸出来。

做法
----
只用本地缓存（use_cache=True），把会联网的三步打桩（远程 etag、灵衣名、活动加成），
其余全部走真实代码路径；跑在临时库副本上，绝不碰 db/fgo_data.db。

跑法
----
    cd FGOBondApp
    python python-engine/tests/update_smoke.py
"""
import shutil
import sys
import tempfile
from pathlib import Path

try:  # Windows 控制台默认 GBK，打印 ✅ / ❌ 会抛 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]          # python-engine/tests/xxx.py → 仓库根
sys.path.insert(0, str(ROOT / "python-engine"))

from engine import data_fetcher, database, event_bonus  # noqa: E402

DB_SRC = ROOT / "db" / "fgo_data.seed.db"


def main() -> int:
    if not DB_SRC.exists():
        print("跳过：找不到", DB_SRC, "（需要先跑 scripts/make_seed.cjs）")
        return 0
    tmpdir = Path(tempfile.mkdtemp(prefix="engine-update-smoke-"))
    db = tmpdir / "fgo_data.db"
    shutil.copyfile(DB_SRC, db)
    try:
        # 会联网的三处打桩；其余走真实实现（数据读本地缓存）
        data_fetcher.get_remote_export_meta = lambda *a, **k: {"etag": "smoke", "last_modified": ""}
        data_fetcher.refresh_costume_names = lambda **k: {"costume_names": 0}
        event_bonus.update_event_bond_bonus = lambda **k: {"event_bonus": 0}

        steps = []
        stats = data_fetcher.update_database(
            region="jp",
            db_path=db,
            use_cache=True,
            progress=lambda m: steps.append(m),
        )

        conn = database.connect(db)
        try:
            servants = conn.execute("SELECT COUNT(1) AS c FROM servants").fetchone()["c"]
            crafts = conn.execute("SELECT COUNT(1) AS c FROM crafts").fetchone()["c"]
            revision = database.get_meta(conn, "static_revision") or ""
            etag = database.get_meta(conn, "servant_etag") or ""
        finally:
            conn.close()

        print("update_database 返回 status =", stats.get("status"))
        print("进度：", " → ".join(steps))
        print("重建后：从者", servants, "／礼装", crafts, "／etag", etag, "／指纹", "有" if revision else "无")

        problems = []
        if stats.get("status") != "success":
            problems.append("status 不是 success：" + str(stats))
        if servants < 400 or crafts < 2000:
            problems.append("静态数据不完整：从者 %s 礼装 %s" % (servants, crafts))
        if not revision:
            problems.append("static_revision 没写进去")
        if not etag:
            problems.append("servant_etag 没写进去")
        if problems:
            print("❌ 失败：")
            for p in problems:
                print("   -", p)
            return 1
        print("✅ 通过：「更新数据」整条路走通（无 NameError、静态数据齐全）")
        return 0
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
