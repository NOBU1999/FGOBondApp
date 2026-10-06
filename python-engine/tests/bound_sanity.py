# -*- coding: utf-8 -*-
"""剪枝"上界"自检：上界必须真的 ≥ 实际分（否则会误杀真·前排队伍）。

为什么要有它
------------
2026-10-06 的玩家反馈（「1.16 的方案二不如 1.10」+「11.096 那支队算不出来」）查出来：
剪枝用的 `_relaxed_score_upper_bound()` **不是上界** —— 它当时把"最优礼装组合"取自
一个 beam 宽度只有 12 的礼装 DP（`_dp_top_craft_combinations`）。当候选礼装 Cost 全相同时，
DP 状态塌成"按张数一个状态"、每状态只留 12 条，真实最优组合的中途前缀挤不进前 12 →
整条路径被剪断 → 上界偏低（实测 9.864，而真实分 11.096）→ 低于 Top-N 阈值 → **整队被跳过**。

这类"估计值算错"的 bug 平时看不出来（不报错、不崩，只是悄悄地少给结果），
所以必须有一条断言"实际分 ≤ 上界"的自检兜住。

做法
----
用**仓库自带的种子库** + 合成请求跑一次真搜索，把 `req.debugBoundCheck` 打开，
读结果里的 `_boundCheck.maxGap`（引擎在打分处逐队比较"实际分 − 上界"）。
`maxGap > 0` 即失败。**不碰 db/fgo_data.db、不联网、不用任何玩家数据。**

跑法
----
    cd FGOBondApp
    python python-engine/tests/bound_sanity.py

退出码 0 = 通过；1 = 上界被违反（或没比到任何队伍）。
"""
import sys
from pathlib import Path

try:  # Windows 控制台默认 GBK，打印 ✅ / ❌ 会抛 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]          # python-engine/tests/xxx.py → 仓库根
sys.path.insert(0, str(ROOT / "python-engine"))

from engine import calculator, models, search  # noqa: E402

DB_SRC = ROOT / "db" / "fgo_data.seed.db"
# 用例形状刻意贴近 2026-10-06 那个反馈：骑阶 + 戴冠战（= 6 个礼装位、候选礼装 Cost 多为 12），
# 这种"多张同价礼装一起吃满"的局面正是 beam DP 会剪断最优路径的地方。
CLASS_GROUP = "rider"
TOP_N = 200
BOX_SIZE = 80


def main() -> int:
    if not DB_SRC.exists():
        print("跳过：找不到", DB_SRC, "（需要先跑 scripts/make_seed.cjs）")
        return 0

    ctx = calculator.load_context(str(DB_SRC), region="jp")
    servant_ids = sorted(
        s.id for s in ctx.servants.values() if s.servant_class == CLASS_GROUP
    )[:BOX_SIZE]
    if len(servant_ids) < 20:
        print("跳过：种子库里 %s 从者太少（%d 个）" % (CLASS_GROUP, len(servant_ids)))
        return 0

    request = {
        "box": [{"id": sid, "stage": "fourth", "maxBond": False} for sid in servant_ids],
        "mode": "crown",
        "crownPositions": ["front_left", "front_right"],
        "classGroup": CLASS_GROUP,
        "costLimit": 115,
        "topN": TOP_N,
        "timeoutMs": 30000,
        "craftPoolSize": 60,
        "sortMode": "multiplier",
        "strategy": "total_max",
        "baseBond": 0,
        "debugBoundCheck": True,
    }
    req = models.parse_request(request)

    result = search.search_top_teams(ctx, req, progress=lambda _m: None)
    bc = result.get("_boundCheck")

    print("结果条数:", len(result.get("top20") or []), "| 候选阵容数:", result.get("totalCandidates"))
    if not bc:
        print("❌ 没有拿到 _boundCheck（debugBoundCheck 没生效？）")
        return 1
    print("上界自检：比较 %d 个阵容，最大缺口 %s" % (bc.get("checked"), bc.get("maxGap")))
    if bc.get("worst"):
        print("最严重的一例:", bc["worst"])

    problems = []
    if not bc.get("checked"):
        problems.append("一个阵容都没比到（剪枝可能从没触发，用例失去意义）")
    if float(bc.get("maxGap") or 0.0) > 1e-9:
        problems.append(
            "上界被违反：实际分比上界高 %s —— 剪枝会把本来能进前排的队伍误杀"
            % bc.get("maxGap")
        )

    print()
    if problems:
        for p in problems:
            print("[失败]", p)
        print("\n结论：❌ 剪枝上界不可信，先修 _relaxed_score_upper_bound()")
        return 1
    print("结论：✅ 上界成立（实际分 ≤ 上界），剪枝不会因估计偏低误杀队伍")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
