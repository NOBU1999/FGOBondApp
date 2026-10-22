# -*- coding: utf-8 -*-
"""引擎"零件级"断言（不建应用、不起 Electron、不联网、秒级）。

为什么要有它
------------
我们原有的仪器都是**端到端**的：13 档指纹比 sha、契约、渲染层 e2e、真实请求。
它们只能回答"结果变了没有"，不能回答"哪个函数坏了" —— 每次定位 bug 都要"提假设 → 跑长串
（30~300s）→ 否掉 → 再提一个"。本文件把**可以独立断言的性质**直接钉在函数级，
让定位从"跑长串"变成"跑 3 秒"。

写法约定
--------
- 只用标准库；不导入界面层；不读玩家数据。
- 需要静态库（`db/fgo_data.db` 或 `db/fgo_data.seed.db`）的检查会自动 SKIP（与 tests/README 的约定一致）。
- 断言只写**不变量**（"上界必须 ≥ 实际分"这种），**不要把"当前行为"钉死** ——
  否则会把 bug 固化成规格。
- 已知不成立、但本轮不修的，标 `known_broken=True` ⇒ 报 XFAIL 而不是 FAIL（会打印实测缺口）。

跑法
----
    cd FGOBondApp
    python python-engine/tests/engine_units.py            # 全跑
    python python-engine/tests/engine_units.py --list     # 只列检查项
    python python-engine/tests/engine_units.py --only=dp  # 只跑名字含 dp 的

退出码：0 = 全部通过（含 SKIP/XFAIL）；1 = 有 FAIL/ERROR。
"""
import sys
import tempfile
import traceback
from collections import Counter
from pathlib import Path

try:  # Windows 控制台默认 GBK，打印 ✅/❌ 会抛 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parents[2]          # python-engine/tests/xxx.py → 仓库根
sys.path.insert(0, str(ROOT / "python-engine"))

from engine import calculator, models, search  # noqa: E402

CHECKS = []


class Skip(Exception):
    """条件不具备（例如本地没有静态库）——不算失败。"""


def check(name, needs_ctx=False, known_broken=False, doc=""):
    def deco(fn):
        CHECKS.append({"name": name, "fn": fn, "needs_ctx": needs_ctx,
                       "known_broken": known_broken, "doc": doc})
        return fn
    return deco


def require(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------- 公共夹具 ----------------
_DB_CANDIDATES = [ROOT / "db" / "fgo_data.db", ROOT / "db" / "fgo_data.seed.db"]
_CTX_CACHE = {}


def load_ctx():
    if "ctx" in _CTX_CACHE:
        return _CTX_CACHE["ctx"]
    for p in _DB_CANDIDATES:
        if p.exists():
            _CTX_CACHE["ctx"] = calculator.load_context(str(p), region="jp")
            _CTX_CACHE["db"] = p
            return _CTX_CACHE["ctx"]
    raise Skip("本地没有 db/fgo_data.db 或 db/fgo_data.seed.db")


def parse_req(**over):
    base = {
        "box": [{"id": 100100, "stage": "fourth", "maxBond": False}],
        "mode": "normal",
        "costLimit": 116,
        "topN": 20,
        "timeoutMs": 60000,
        "craftPoolSize": 60,
        "sortMode": "multiplier",
        "strategy": "total_max",
        "baseBond": 0,
    }
    base.update(over)
    return models.parse_request(base)


def cost12_pool(ctx, n=8):
    """取 n 张 Cost=12 的普通（非牵绊）礼装 id —— 把 DP 状态压成"按张数一个状态"，
    正是 2026-10-09 那个"重复装同一张"缺陷会现形的局面。"""
    ids = [cid for cid, c in sorted(ctx.crafts.items())
           if getattr(c, "cost", None) == 12 and not getattr(c, "is_bond_ce", False)]
    if len(ids) < 3:
        raise Skip("静态库里 Cost=12 的普通礼装太少")
    return ids[:n]


# ---------------- 检查项 ----------------
@check("same_score_alt_rebase",
       doc="合并同分行时，别的行的替补并进来必须按本行 head 重算 changed / 重排（预设方案6 的 bug）")
def t_alt_rebase():
    slot_order = ["front_left", "front_middle", "back_left", "back_middle", "back_right"]
    head = {"front_left": 1, "front_middle": 2, "back_left": 3, "back_middle": 4, "back_right": 5}
    # 另一行（会被并进来）的后排是 {3, 9, 5}：对它自己来说 9 是本位，对 head 来说是"换上来的人"
    other = {"front_left": 1, "front_middle": 2, "back_left": 3, "back_middle": 9, "back_right": 5}
    other_entry = {"front_left": (1, None, None), "front_middle": (2, None, None),
                   "back_left": (3, None, None), "back_middle": (9, None, None), "back_right": (5, None, None)}
    alt = search._alt_payload(slot_order, other, other_entry,
                              {"craftId": -10, "secondCraftId": None})
    require(alt["changed"] == [0, 0, 0, 0, 0], "相对它自己那一行不该算换人：%r" % (alt["changed"],))

    rebased = search._rebase_alt(alt, slot_order, head)
    idx = {p: i for i, p in enumerate(rebased["positions"])}
    require(rebased["changed"][idx["back_middle"]] == 1,
            "并进 head 后 back_middle 应为换上来的人：%r" % (rebased,))
    require(sum(rebased["changed"]) == 1, "并进 head 后应只有 1 处换人：%r" % (rebased["changed"],))
    require(rebased["servantIds"][idx["back_middle"]] == 9, "重排后位置上的人不能变")
    # 去重键不变（前后排集合口径）
    require(search._entry_key(alt) == search._entry_key(rebased), "rebase 不应改变去重键")


@check("same_score_alt_display_order",
       doc="同分替补的对外结构：positions 按「前排→后排，各段换掉的在前」排；changed 用前后排集合口径")
def t_alt_display_order():
    slot_order = ["front_left", "front_middle", "back_left", "back_middle", "back_right"]
    head = {"front_left": 1, "front_middle": 2, "back_left": 3, "back_middle": 4, "back_right": 5}

    def payload(entry):
        return search._alt_payload(slot_order, head, entry, {"craftId": -10, "secondCraftId": None})

    def entry(**over):
        base = {
            "front_left": (1, None, None), "front_middle": (2, None, None),
            "back_left": (3, None, None), "back_middle": (4, None, None),
            "back_right": (5, None, None),
        }
        base.update(over)
        return base

    # 1) 只换后排左：前排（未换）在前，后排"换掉的"在前、"没换的"在后
    p = payload(entry(back_left=(9, None, None)))
    require(p["positions"] == ["front_left", "front_middle", "back_left", "back_middle", "back_right"],
            "只换后排左的顺序不对：%r" % (p["positions"],))
    require(p["changed"] == [0, 0, 1, 0, 0], "changed 不对：%r" % (p["changed"],))
    require(p["servantIds"][2] == 9, "换上来的人没落在 back_left：%r" % (p["servantIds"],))

    # 2) 只换前排中：前排里"换掉的"要排到该段最前
    p = payload(entry(front_middle=(8, None, None)))
    require(p["positions"] == ["front_middle", "front_left", "back_left", "back_middle", "back_right"],
            "前排换人后顺序不对：%r" % (p["positions"],))
    require(p["changed"] == [1, 0, 0, 0, 0], "changed 不对：%r" % (p["changed"],))

    # 3) 同一侧内部换位（集合不变）⇒ 一个人都不算换
    p = payload(entry(front_left=(2, None, None), front_middle=(1, None, None)))
    require(p["changed"] == [0, 0, 0, 0, 0], "同侧换位被误判成换人：%r" % (p["changed"],))

    # 4) 前后都换：前排换掉的 → 前排没换的 → 后排换掉的 → 后排没换的
    p = payload(entry(front_middle=(8, None, None), back_right=(9, None, None)))
    require(p["positions"] == ["front_middle", "front_left", "back_right", "back_left", "back_middle"],
            "前后都换时顺序不对：%r" % (p["positions"],))
    require(p["changed"] == [1, 0, 1, 0, 0], "changed 不对：%r" % (p["changed"],))

    # 5) 去重键只看前后排集合：同侧换位不产生新键
    k1 = search._entry_key(payload(entry()))
    k2 = search._entry_key(payload(entry(front_left=(2, None, None), front_middle=(1, None, None))))
    require(k1 == k2, "同侧换位应被视为同一支队伍（去重键不同）")


@check("trip_recheck_count_bounds",
       doc="⑨ 集合趟自由口径复评的条数上限：确定性 + 档位单调 + 落在 clamp 区间内（③-b 的靶子）")
def t_trip_count():
    rows = []
    for ms in (35000, 60000, 90000, 135000, 300000, 3600000):
        rows.append((ms, search._default_trip_recheck_count(parse_req(timeoutMs=ms))))
    vals = [v for _, v in rows]
    require(all(256 <= v <= 2048 for v in vals), "非超级档越界（应落在 [256, 2048]）：%r" % (rows,))
    require(vals == sorted(vals), "档位越大条数不应变小：%r" % (rows,))
    require(vals[0] == 256, "最短档应贴下界 256，实际 %d" % vals[0])
    # 超级模式 ×4，上限 8192
    sup = search._default_trip_recheck_count(parse_req(timeoutMs=3600000, superMode=10))
    require(sup == min(8192, vals[-1] * 4), "超级模式应 ×4（上限 8192），实际 %d" % sup)
    # 同一请求必须给同一个数（确定性：整数预算，墙钟只兜底）
    require(search._default_trip_recheck_count(parse_req(timeoutMs=300000)) == vals[4],
            "同一请求两次给出不同条数 ⇒ 不确定")


@check("scoring_profile_differs",
       doc="坑 111：按点数 / 按倍率的「权重 + 口径」必须可区分（缓存键漏了它就会串味）")
def t_scoring_profile():
    mult = parse_req(sortMode="multiplier", baseBond=0)
    points = parse_req(sortMode="points", baseBond=1200)
    no_base = parse_req(sortMode="points", baseBond=0)
    a = (search._uses_points_scoring(mult), search._relaxed_percent_weight(mult))
    b = (search._uses_points_scoring(points), search._relaxed_percent_weight(points))
    c = (search._uses_points_scoring(no_base), search._relaxed_percent_weight(no_base))
    require(a == (False, 1.0), "按倍率口径应为 (False, 1.0)，实际 %r" % (a,))
    require(b == (True, 1200.0), "按点数口径应为 (True, 1200.0)，实际 %r" % (b,))
    require(a != b, "两种口径的「权重+口径」完全相同 ⇒ 挂在 ctx 上的缓存会串味")
    require(c == a, "按点数但没填基础牵绊应退回按倍率（否则全体同分），实际 %r" % (c,))


@check("craft_dp_no_duplicate_nonrepeatable", needs_ctx=True,
       doc="坑 109：DP 生成的礼装组合里，不可重复的礼装不得出现两次；可重复的应能占满槽位")
def t_dp_duplicates():
    ctx = load_ctx()
    rep = set(search._repeatable_craft_ids(ctx))
    pool = cost12_pool(ctx)
    scores = {cid: 1.12 for cid in pool}
    out = search._dp_top_craft_combinations(ctx, pool, 6, 60, rep, None, scores, top_k=12)
    require(bool(out), "DP 一条组合都没返回")
    bad = [combo for _, combo in out
           if any(k not in rep and v > 1 for k, v in Counter(combo).items())]
    require(not bad, "出现重复装同一张不可重复礼装：%r" % (bad[:2],))
    require(all(cost <= 60 for cost, _ in out), "返回了超预算的组合：%r" % (out[:2],))
    # 正控：可重复礼装要真能重复（不然"防重复"可能只是把可重复的也一起禁了）
    rep_in_ctx = [cid for cid in rep if cid in ctx.crafts]
    if not rep_in_ctx:
        raise Skip("本库里没有可重复礼装（-10 通用5%）")
    one = rep_in_ctx[0]
    rep_out = search._dp_top_craft_combinations(ctx, [one], 3, 60, rep, None, {one: 1.0}, top_k=12)
    combos = [c for _, c in rep_out]
    require(any(c.count(one) == 3 for c in combos),
            "可重复礼装没能占满 3 个槽位（实际 %r）" % (combos[:3],))


@check("craft_enum_no_duplicate_nonrepeatable", needs_ctx=True,
       doc="礼装组合枚举（走 _generate_craft_combinations_with_cost 那条路）同样不得重复装")
def t_enum_duplicates():
    ctx = load_ctx()
    rep = set(search._repeatable_craft_ids(ctx))
    pool = cost12_pool(ctx, n=6)
    out = search._generate_craft_combinations_with_cost(ctx, pool, 3, 300, None)
    require(bool(out), "枚举一条组合都没返回")
    bad = [combo for _, combo in out
           if any(k not in rep and v > 1 for k, v in Counter(combo).items())]
    require(not bad, "枚举里出现重复装同一张不可重复礼装：%r" % (bad[:2],))
    same = search._generate_craft_combinations_with_cost(ctx, pool, 3, 300, None)
    require(same == out, "同一输入两次枚举结果不同 ⇒ 非确定性")


@check("upper_bound_ge_actual", needs_ctx=True,
       doc="坑 113/94：剪枝上界必须 ≥ 同阵容的实际分（本用例形状未发现击穿；r7 形状见坑 113）")
def t_ub_ge_actual():
    ctx = load_ctx()
    # 用例形状贴近真实场景：骑阶 + 戴冠战（6 个礼装位、礼装 Cost 多为 12）
    servant_ids = sorted(s.id for s in ctx.servants.values()
                         if getattr(s, "servant_class", None) == "rider")[:80]
    require(len(servant_ids) >= 20, "种子库里骑阶从者太少（%d）" % len(servant_ids))
    req = models.parse_request({
        "box": [{"id": sid, "stage": "fourth", "maxBond": False} for sid in servant_ids],
        "mode": "crown",
        "crownPositions": ["front_left", "front_right"],
        "classGroup": "rider",
        "costLimit": 115,
        "topN": 200,
        # ⚠️ 预算别压太低：这个形状光是"生成候选池 + 枚举组合"就要 ~25 秒（2026-10-22 实测
        #    首个评估出现在 24.6s），预算 30s 时第一阶段（50% = 15s）就先到期 ⇒
        #    一条都没评估 ⇒ 用例假失败（坑 118）。给 90s 留出评估窗口。
        "timeoutMs": 90000,
        "craftPoolSize": 60,
        "sortMode": "multiplier",
        "strategy": "total_max",
        "baseBond": 0,
    })

    ub_by_players = {}
    orig_ub = search._relaxed_score_upper_bound

    def ub_wrap(c, r, players, *a, **kw):
        v = orig_ub(c, r, players, *a, **kw)
        try:
            key = frozenset(p.servant_id for p in players)
            if len(key) == 5 and v is not None:
                ub_by_players[key] = max(ub_by_players.get(key, -1e18), float(v))
        except Exception:  # noqa: BLE001
            pass
        return v

    search._relaxed_score_upper_bound = ub_wrap
    try:
        res = search.search_top_teams(ctx, req, progress=lambda _m: None)
    finally:
        search._relaxed_score_upper_bound = orig_ub

    def players_of(team_like):
        ids = set()
        for m in team_like or []:
            if m.get("isSupport"):
                continue
            sid = m.get("servantId")
            if sid is not None:
                ids.add(int(sid))
        return frozenset(ids)

    actual_by_players = {}
    rows = res.get("top20") or []

    def note(team_like, score):
        if score is None:
            return
        key = players_of(team_like)
        if len(key) == 5:
            actual_by_players[key] = max(actual_by_players.get(key, -1e18), float(score))

    for it in rows:
        score = it.get("totalMultiplier", it.get("multiplier", it.get("score")))
        team = it.get("team") or []
        note(team, score)
        sup_ids = {int(m.get("servantId")) for m in team if m.get("isSupport") and m.get("servantId")}
        for alt in it.get("sameScoreTeams") or []:
            ids = [int(x) for x in (alt.get("servantIds") or []) if int(x) not in sup_ids]
            note([{"servantId": x} for x in ids], score)

    pairs = [(k, actual_by_players[k], ub_by_players[k])
             for k in actual_by_players if k in ub_by_players]
    require(pairs, "没有一组「同阵容既有上界又有实际分」可比较（上界记录 %d / 实际记录 %d）"
                   % (len(ub_by_players), len(actual_by_players)))
    gaps = [(a - u, k, a, u) for k, a, u in pairs]
    gaps.sort(reverse=True)
    worst_gap, _k, worst_a, worst_u = gaps[0]
    broken = [g for g in gaps if g[0] > 1e-9]
    print("       · 覆盖：上界记录 %d 个阵容 / 结果侧 %d 个阵容 ⇒ 可比 %d 组；最大缺口 %.4f"
          % (len(ub_by_players), len(actual_by_players), len(pairs), worst_gap))
    require(worst_gap <= 1e-9,
            "上界被击穿：%d/%d 组「实际 > 上界」，最大缺口 %.4f（实际 %.4f vs 上界 %.4f，阵容 %s）"
            % (len(broken), len(pairs), worst_gap, worst_a, worst_u, sorted(_k)))


@check("download_retries_transient_failures",
       doc="坑 121：大文件下载中途偶发断开要自动重试，别整条白跑（Atlas 实测在 84% 断过）")
def t_download_retries():
    from engine import data_fetcher as df

    payload = b"0123456789" * 10
    real_raw = df._download_range_raw
    real_wait = df.DOWNLOAD_RETRY_WAIT
    tmpdir = Path(tempfile.mkdtemp(prefix="fgo-dl-retry-"))
    df.DOWNLOAD_RETRY_WAIT = 0.01  # 别在测试里真等 1.5s/3s
    try:
        # ① 前两次抛错、第三次成功 ⇒ 文件必须完整、且确实重试了
        calls = {"n": 0}

        def flaky(url, start, end):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise OSError("simulated SSL EOF")
            return payload, len(payload)

        df._download_range_raw = flaky
        out = df.download_to_cache("http://example.invalid/x.json", tmpdir / "ok.json", "retry-test")
        require(out.exists(), "重试成功后文件不存在")
        require(out.read_bytes() == payload, "重试后文件内容不完整（%d 字节）" % out.stat().st_size)
        require(calls["n"] == 3, "应「失败 2 次 + 成功 1 次」共 3 次调用，实际 %d 次" % calls["n"])

        # ② 一直失败 ⇒ 用满重试次数后必须抛错（不能静默返回半截文件）
        calls["n"] = 0

        def broken(url, start, end):
            calls["n"] += 1
            raise OSError("always broken")

        df._download_range_raw = broken
        raised = False
        try:
            df.download_to_cache("http://example.invalid/y.json", tmpdir / "bad.json", "retry-test")
        except Exception:  # noqa: BLE001
            raised = True
        require(raised, "永久失败时必须抛错，不能当成下载成功")
        require(calls["n"] == df.DOWNLOAD_RETRIES + 1,
                "重试次数应为 %d，实际调用 %d 次" % (df.DOWNLOAD_RETRIES + 1, calls["n"]))
    finally:
        df._download_range_raw = real_raw
        df.DOWNLOAD_RETRY_WAIT = real_wait


def main() -> int:
    only = ""
    for a in sys.argv[1:]:
        if a.startswith("--only="):
            only = a.split("=", 1)[1]
    if "--list" in sys.argv:
        for c in CHECKS:
            tag = " [known-broken]" if c["known_broken"] else ""
            print(f"  {c['name']}{tag}   {c['doc']}")
        return 0

    n_pass = n_skip = n_xfail = 0
    failures = []
    print("引擎零件级断言（%d 项）\n" % len(CHECKS))
    for c in CHECKS:
        if only and only not in c["name"]:
            continue
        try:
            if c["needs_ctx"]:
                load_ctx()
            c["fn"]()
        except Skip as exc:
            n_skip += 1
            print(f"  ⏭️  SKIP  {c['name']}  —— {exc}")
        except AssertionError as exc:
            if c["known_broken"]:
                n_xfail += 1
                print(f"  ⚠️  XFAIL {c['name']}  —— {exc}")
            else:
                n_xfail += 0
                failures.append((c["name"], str(exc)))
                print(f"  ❌ FAIL  {c['name']}  —— {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append((c["name"], f"{type(exc).__name__}: {exc}"))
            print(f"  💥 ERROR {c['name']}  —— {type(exc).__name__}: {exc}")
            print("     " + traceback.format_exc(limit=3).replace("\n", "\n     ")[:600])
        else:
            n_pass += 1
            print(f"  ✅ PASS  {c['name']}")

    print(f"\nPASS {n_pass} ｜ SKIP {n_skip} ｜ XFAIL {n_xfail} ｜ FAIL {len(failures)}")
    if failures:
        print("\n失败明细：")
        for name, msg in failures:
            print(f"  - {name}: {msg}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
