// 引擎「零件级」断言（TS 版，对齐 python-engine/tests/engine_units.py 的 9 项）
//
// 为什么要有它：13 档指纹 / golden 对拍这些仪器只回答"结果变了没有"，
// 不能回答"哪个函数坏了"。本文件把可以独立断言的性质钉在函数级，定位从"跑长串"变成"跑几秒"。
//
// 写法约定（与 Python 版一致）：
//  · 只断言**不变量**（"上界必须 ≥ 实际分"这种），不把"当前行为"钉死；
//  · 需要静态库（db/fgo_data.db 或 db/fgo_data.seed.db）的检查，找不到就 SKIP；
//  · 已知不成立但本轮不修的标 knownBroken ⇒ 报 XFAIL。
//
// 跑法：
//   node engine-units.ts                 # 全跑
//   node engine-units.ts --list          # 只列检查项
//   node engine-units.ts --only=dp       # 只跑名字含 dp 的
// 退出码：0 = 全部通过（含 SKIP/XFAIL）；1 = 有 FAIL/ERROR
import "../src/platformNode.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadContext } from "../src/calculator.ts";
import { parseRequest } from "../src/models.ts";
import type { CalculationRequest } from "../src/models.ts";
import { searchTopTeams } from "../src/search.ts";
import {
  altPayload,
  entryKey,
  rebaseAlt,
  defaultTripRecheckCount,
  relaxedScoreUpperBound as relaxedScoreUpperBoundRef,
  type SearchHooks,
} from "../src/search.ts";
import { generateCraftCombinationsWithCost } from "../src/pool.ts";
import {
  dpTopCraftCombinations,
  relaxedPercentWeight,
  repeatableCraftIds,
  usesPointsScoring,
} from "../src/relaxed.ts";
import { downloadToCache } from "../src/dataFetch.ts";
import type { DataContext } from "../src/calculator.ts";

const APP_ROOT = process.env.FGO_APP_ROOT ?? "D:/dsh-agent/fgo/FGOBondApp";
const UB_SWEEP_SHAPES = 12;
const UB_SWEEP_BUDGET_MS = 1200;

class Skip extends Error {}
class CheckFailed extends Error {}

type Check = {
  name: string;
  doc: string;
  needsCtx?: boolean;
  knownBroken?: boolean;
  fn: () => Promise<void> | void;
};

const CHECKS: Check[] = [];
function check(name: string, doc: string, opts: Omit<Check, "name" | "doc" | "fn"> = {}) {
  return (fn: () => Promise<void> | void): void => {
    CHECKS.push({ name, doc, ...opts, fn });
  };
}

function require_(cond: any, msg: string): void {
  if (!cond) throw new CheckFailed(msg);
}

// ---------------- 公共夹具 ----------------
const DB_CANDIDATES = [
  path.join(APP_ROOT, "db", "fgo_data.db"),
  path.join(APP_ROOT, "db", "fgo_data.seed.db"),
];
let CTX: DataContext | null = null;

async function loadCtx(): Promise<DataContext> {
  if (CTX) return CTX;
  for (const p of DB_CANDIDATES) {
    if (fs.existsSync(p)) {
      CTX = await loadContext(p, "jp");
      return CTX;
    }
  }
  throw new Skip("本地没有 db/fgo_data.db 或 db/fgo_data.seed.db");
}

function parseReq(over: Record<string, any> = {}): CalculationRequest {
  const base: Record<string, any> = {
    box: [{ id: 100100, stage: "fourth", maxBond: false }],
    mode: "normal",
    costLimit: 116,
    topN: 20,
    timeoutMs: 60000,
    craftPoolSize: 60,
    sortMode: "multiplier",
    strategy: "total_max",
    baseBond: 0,
  };
  return parseRequest({ ...base, ...over });
}

/** 取 n 张 Cost=12 的普通（非牵绊）礼装 —— 把 DP 状态压成"按张数一个状态"，
 *  正是 2026-10-09 那个"重复装同一张"缺陷会现形的局面。 */
function cost12Pool(ctx: DataContext, n = 8): number[] {
  const ids = [...ctx.crafts.entries()]
    .filter(([, c]) => c.cost === 12 && !c.is_bond_ce)
    .map(([cid]) => cid)
    .sort((a, b) => a - b);
  if (ids.length < 3) throw new Skip("静态库里 Cost=12 的普通礼装太少");
  return ids.slice(0, n);
}

function counts(combo: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const cid of combo) m.set(cid, (m.get(cid) ?? 0) + 1);
  return m;
}

// ---------------- 检查项 ----------------
check(
  "same_score_alt_rebase",
  "合并同分行时，别的行的替补并进来必须按本行 head 重算 changed / 重排（预设方案6 的 bug）",
)(() => {
  const slotOrder = ["front_left", "front_middle", "back_left", "back_middle", "back_right"];
  const head = new Map<string, number>([
    ["front_left", 1],
    ["front_middle", 2],
    ["back_left", 3],
    ["back_middle", 4],
    ["back_right", 5],
  ]);
  // 另一行（会被并进来）的后排是 {3, 9, 5}：对它自己来说 9 是本位，对 head 来说是"换上来的人"
  const other = new Map<string, number>([
    ["front_left", 1],
    ["front_middle", 2],
    ["back_left", 3],
    ["back_middle", 9],
    ["back_right", 5],
  ]);
  const otherEntry = new Map<string, [number, number | null, number | null]>([
    ["front_left", [1, null, null]],
    ["front_middle", [2, null, null]],
    ["back_left", [3, null, null]],
    ["back_middle", [9, null, null]],
    ["back_right", [5, null, null]],
  ]);
  const alt = altPayload(slotOrder, other, otherEntry, { craftId: -10, secondCraftId: null });
  require_(JSON.stringify(alt.changed) === JSON.stringify([0, 0, 0, 0, 0]), `相对它自己那一行不该算换人：${JSON.stringify(alt.changed)}`);

  const rebased = rebaseAlt(alt, slotOrder, head);
  const idx = new Map<string, number>();
  rebased.positions.forEach((p: string, i: number) => idx.set(p, i));
  require_(rebased.changed[idx.get("back_middle")!] === 1, `并进 head 后 back_middle 应为换上来的人：${JSON.stringify(rebased)}`);
  require_(rebased.changed.reduce((a: number, b: number) => a + b, 0) === 1, `并进 head 后应只有 1 处换人：${JSON.stringify(rebased.changed)}`);
  require_(rebased.servantIds[idx.get("back_middle")!] === 9, "重排后位置上的人不能变");
  require_(entryKey(alt) === entryKey(rebased), "rebase 不应改变去重键");
});

check(
  "same_score_alt_display_order",
  "同分替补的对外结构：positions 按「前排→后排，各段换掉的在前」排；changed 用前后排集合口径",
)(() => {
  const slotOrder = ["front_left", "front_middle", "back_left", "back_middle", "back_right"];
  const head = new Map<string, number>([
    ["front_left", 1],
    ["front_middle", 2],
    ["back_left", 3],
    ["back_middle", 4],
    ["back_right", 5],
  ]);
  type Entry = Map<string, [number, number | null, number | null]>;
  const entry = (over: Record<string, number> = {}): Entry => {
    const base: Record<string, [number, number | null, number | null]> = {
      front_left: [1, null, null],
      front_middle: [2, null, null],
      back_left: [3, null, null],
      back_middle: [4, null, null],
      back_right: [5, null, null],
    };
    for (const k of Object.keys(over)) base[k] = [over[k], null, null];
    return new Map(Object.entries(base));
  };
  const payload = (e: Entry): any => altPayload(slotOrder, head, e, { craftId: -10, secondCraftId: null });

  // 1) 只换后排左：前排（未换）在前，后排"换掉的"在前、"没换的"在后
  let p = payload(entry({ back_left: 9 }));
  require_(JSON.stringify(p.positions) === JSON.stringify(slotOrder), `只换后排左的顺序不对：${JSON.stringify(p.positions)}`);
  require_(JSON.stringify(p.changed) === JSON.stringify([0, 0, 1, 0, 0]), `changed 不对：${JSON.stringify(p.changed)}`);
  require_(p.servantIds[2] === 9, `换上来的人没落在 back_left：${JSON.stringify(p.servantIds)}`);

  // 2) 只换前排中：前排里"换掉的"要排到该段最前
  p = payload(entry({ front_middle: 8 }));
  require_(
    JSON.stringify(p.positions) === JSON.stringify(["front_middle", "front_left", "back_left", "back_middle", "back_right"]),
    `前排换人后顺序不对：${JSON.stringify(p.positions)}`,
  );
  require_(JSON.stringify(p.changed) === JSON.stringify([1, 0, 0, 0, 0]), `changed 不对：${JSON.stringify(p.changed)}`);

  // 3) 同一侧内部换位（集合不变）⇒ 一个人都不算换
  p = payload(entry({ front_left: 2, front_middle: 1 }));
  require_(JSON.stringify(p.changed) === JSON.stringify([0, 0, 0, 0, 0]), `同侧换位被误判成换人：${JSON.stringify(p.changed)}`);

  // 4) 前后都换：前排换掉的 → 前排没换的 → 后排换掉的 → 后排没换的
  p = payload(entry({ front_middle: 8, back_right: 9 }));
  require_(
    JSON.stringify(p.positions) === JSON.stringify(["front_middle", "front_left", "back_right", "back_left", "back_middle"]),
    `前后都换时顺序不对：${JSON.stringify(p.positions)}`,
  );
  require_(JSON.stringify(p.changed) === JSON.stringify([1, 0, 1, 0, 0]), `changed 不对：${JSON.stringify(p.changed)}`);

  // 5) 去重键只看前后排集合：同侧换位不产生新键
  const k1 = entryKey(payload(entry()));
  const k2 = entryKey(payload(entry({ front_left: 2, front_middle: 1 })));
  require_(k1 === k2, "同侧换位应被视为同一支队伍（去重键不同）");
});

check(
  "trip_recheck_count_bounds",
  "⑨ 集合趟自由口径复评的条数上限：确定性 + 档位单调 + 落在 clamp 区间内（③-b 的靶子）",
)(() => {
  const rows: [number, number][] = [];
  for (const ms of [35000, 60000, 90000, 135000, 300000, 3600000]) {
    rows.push([ms, defaultTripRecheckCount(parseReq({ timeoutMs: ms }))]);
  }
  const vals = rows.map(([, v]) => v);
  require_(vals.every((v) => v >= 256 && v <= 2048), `非超级档越界（应落在 [256, 2048]）：${JSON.stringify(rows)}`);
  require_(
    vals.every((v, i) => i === 0 || vals[i - 1] <= v),
    `档位越大条数不应变小：${JSON.stringify(rows)}`,
  );
  require_(vals[0] === 256, `最短档应贴下界 256，实际 ${vals[0]}`);
  const sup = defaultTripRecheckCount(parseReq({ timeoutMs: 3600000, superMode: 10 }));
  require_(sup === Math.min(8192, vals[vals.length - 1] * 4), `超级模式应 ×4（上限 8192），实际 ${sup}`);
  require_(
    defaultTripRecheckCount(parseReq({ timeoutMs: 300000 })) === vals[4],
    "同一请求两次给出不同条数 ⇒ 不确定",
  );
});

check(
  "scoring_profile_differs",
  "坑 111：按点数 / 按倍率的「权重 + 口径」必须可区分（缓存键漏了它就会串味）",
)(() => {
  const mult = parseReq({ sortMode: "multiplier", baseBond: 0 });
  const points = parseReq({ sortMode: "points", baseBond: 1200 });
  const noBase = parseReq({ sortMode: "points", baseBond: 0 });
  const pick = (r: CalculationRequest): [boolean, number] => [usesPointsScoring(r), relaxedPercentWeight(r)];
  const a = pick(mult);
  const b = pick(points);
  const c = pick(noBase);
  require_(a[0] === false && a[1] === 1, `按倍率口径应为 (false, 1)，实际 ${JSON.stringify(a)}`);
  require_(b[0] === true && b[1] === 1200, `按点数口径应为 (true, 1200)，实际 ${JSON.stringify(b)}`);
  require_(JSON.stringify(a) !== JSON.stringify(b), "两种口径的「权重+口径」完全相同 ⇒ 挂在 ctx 上的缓存会串味");
  require_(JSON.stringify(c) === JSON.stringify(a), `按点数但没填基础牵绊应退回按倍率（否则全体同分），实际 ${JSON.stringify(c)}`);
});

check(
  "craft_dp_no_duplicate_nonrepeatable",
  "坑 109：DP 生成的礼装组合里，不可重复的礼装不得出现两次；可重复的应能占满槽位",
  { needsCtx: true },
)(async () => {
  const ctx = await loadCtx();
  const rep = repeatableCraftIds(ctx);
  const pool = cost12Pool(ctx);
  const scores = new Map<number, number>(pool.map((cid) => [cid, 1.12]));
  const out = dpTopCraftCombinations(ctx, pool, 6, 60, rep, null, scores, 12);
  require_(out.length > 0, "DP 一条组合都没返回");
  const bad = out.filter(([, combo]) => [...counts(combo)].some(([cid, n]) => !rep.has(cid) && n > 1));
  require_(bad.length === 0, `出现重复装同一张不可重复礼装：${JSON.stringify(bad.slice(0, 2))}`);
  require_(out.every(([cost]) => cost <= 60), `返回了超预算的组合：${JSON.stringify(out.slice(0, 2))}`);

  // 正控：可重复礼装要真能重复（不然"防重复"可能只是把可重复的也一起禁了）
  const repInCtx = [...rep].filter((cid) => ctx.crafts.has(cid));
  if (repInCtx.length === 0) throw new Skip("本库里没有可重复礼装（-10 通用5%）");
  const one = repInCtx[0];
  const repOut = dpTopCraftCombinations(ctx, [one], 3, 60, rep, null, new Map([[one, 1]]), 12);
  const combos = repOut.map(([, c]) => c);
  require_(
    combos.some((c) => c.filter((x) => x === one).length === 3),
    `可重复礼装没能占满 3 个槽位（实际 ${JSON.stringify(combos.slice(0, 3))}）`,
  );
});

check(
  "craft_enum_no_duplicate_nonrepeatable",
  "礼装组合枚举（走 generateCraftCombinationsWithCost 那条路）同样不得重复装",
  { needsCtx: true },
)(async () => {
  const ctx = await loadCtx();
  const rep = repeatableCraftIds(ctx);
  const pool = cost12Pool(ctx, 6);
  const out = generateCraftCombinationsWithCost(ctx, pool, 3, 300, null);
  require_(out.length > 0, "枚举一条组合都没返回");
  const bad = out.filter(([, combo]) => [...counts(combo)].some(([cid, n]) => !rep.has(cid) && n > 1));
  require_(bad.length === 0, `枚举里出现重复装同一张不可重复礼装：${JSON.stringify(bad.slice(0, 2))}`);
  const same = generateCraftCombinationsWithCost(ctx, pool, 3, 300, null);
  require_(JSON.stringify(same) === JSON.stringify(out), "同一输入两次枚举结果不同 ⇒ 非确定性");
});

check(
  "upper_bound_ge_actual",
  "坑 113/94：剪枝上界必须 ≥ 同阵容的实际分（本用例形状未发现击穿；r7 形状见坑 113）",
  { needsCtx: true },
)(async () => {
  const ctx = await loadCtx();
  // 用例形状贴近真实场景：骑阶 + 戴冠战（6 个礼装位、礼装 Cost 多为 12）
  const servantIds = [...ctx.servants.values()]
    .filter((s) => s.servant_class === "rider")
    .map((s) => s.id)
    .sort((a, b) => a - b)
    .slice(0, 80);
  require_(servantIds.length >= 20, `种子库里骑阶从者太少（${servantIds.length}）`);
  const req = parseRequest({
    box: servantIds.map((sid) => ({ id: sid, stage: "fourth", maxBond: false })),
    mode: "crown",
    crownPositions: ["front_left", "front_right"],
    classGroup: "rider",
    costLimit: 115,
    topN: 200,
    // 预算别压太低：这个形状光是"生成候选池 + 枚举组合"就要 ~25 秒（坑 118）
    timeoutMs: 90000,
    craftPoolSize: 60,
    sortMode: "multiplier",
    strategy: "total_max",
    baseBond: 0,
  });

  const ubByPlayers = new Map<string, number>();
  const hooks: SearchHooks = {
    upperBound: (...args: any[]): number => {
      const v = (relaxedScoreUpperBoundRef as any)(...args);
      const players = args[2] as any[];
      const key = players.map((p) => p.servant_id).sort((a, b) => a - b).join(",");
      if (new Set(players.map((p) => p.servant_id)).size === 5 && v !== undefined) {
        ubByPlayers.set(key, Math.max(ubByPlayers.get(key) ?? -1e18, Number(v)));
      }
      return v;
    },
  };
  const res = await searchTopTeams(ctx, req, null, null, hooks);

  const playersKey = (ids: number[]): string => [...new Set(ids)].sort((a, b) => a - b).join(",");
  const actualByPlayers = new Map<string, number>();
  const rows = res.top20 ?? [];
  const note = (ids: number[], score: any): void => {
    if (score === null || score === undefined) return;
    const key = playersKey(ids);
    if (ids.length === 5) actualByPlayers.set(key, Math.max(actualByPlayers.get(key) ?? -1e18, Number(score)));
  };
  for (const it of rows) {
    const score = it.totalMultiplier ?? it.multiplier ?? it.score;
    const team = it.team ?? [];
    const ids = team.filter((m: any) => !m.isSupport).map((m: any) => Number(m.servantId));
    note(ids, score);
    const supIds = new Set(team.filter((m: any) => m.isSupport).map((m: any) => Number(m.servantId)));
    for (const alt of it.sameScoreTeams ?? []) {
      const altIds = (alt.servantIds ?? []).map((x: any) => Number(x)).filter((x: number) => !supIds.has(x));
      note(altIds, score);
    }
  }

  const pairs: [string, number, number][] = [];
  for (const [k, actual] of actualByPlayers) {
    const ub = ubByPlayers.get(k);
    if (ub !== undefined) pairs.push([k, actual, ub]);
  }
  require_(
    pairs.length > 0,
    `没有一组「同阵容既有上界又有实际分」可比较（上界记录 ${ubByPlayers.size} / 实际记录 ${actualByPlayers.size}）`,
  );
  const gaps = pairs.map(([k, a, u]) => [a - u, k, a, u] as [number, string, number, number]);
  gaps.sort((x, y) => y[0] - x[0]);
  const [worstGap, worstKey, worstA, worstU] = gaps[0];
  const broken = gaps.filter((g) => g[0] > 1e-9);
  console.log(
    `       · 覆盖：上界记录 ${ubByPlayers.size} 个阵容 / 结果侧 ${actualByPlayers.size} 个阵容 ⇒ 可比 ${pairs.length} 组；最大缺口 ${worstGap.toFixed(4)}`,
  );
  require_(
    worstGap <= 1e-9,
    `上界被击穿：${broken.length}/${pairs.length} 组「实际 > 上界」，最大缺口 ${worstGap.toFixed(4)}` +
      `（实际 ${worstA.toFixed(4)} vs 上界 ${worstU.toFixed(4)}，阵容 ${worstKey}）`,
  );
});

check(
  "download_retries_transient_failures",
  "坑 121：大文件下载中途偶发断开要自动重试，别整条白跑（Atlas 实测在 84% 断过）",
)(async () => {
  const payload = Buffer.from("0123456789".repeat(10), "utf8");
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "fgo-dl-retry-"));
  try {
    // ① 前两次抛错、第三次成功 ⇒ 文件必须完整、且确实重试了
    let calls = 0;
    const flaky = async (): Promise<[Uint8Array, number]> => {
      calls += 1;
      if (calls <= 2) throw new Error("simulated SSL EOF");
      return [new Uint8Array(payload), payload.length];
    };
    const okPath = path.join(tmpdir, "ok.json");
    await downloadToCache("http://example.invalid/x.json", okPath, "retry-test", null, () => {}, {
      rangeRaw: flaky,
      retryWaitMs: 10,
    });
    require_(fs.existsSync(okPath), "重试成功后文件不存在");
    require_(
      Buffer.compare(fs.readFileSync(okPath), payload) === 0,
      `重试后文件内容不完整（${fs.statSync(okPath).size} 字节）`,
    );
    require_(calls === 3, `应「失败 2 次 + 成功 1 次」共 3 次调用，实际 ${calls} 次`);

    // ② 一直失败 ⇒ 用满重试次数后必须抛错（不能静默返回半截文件）
    calls = 0;
    const broken = async (): Promise<[Uint8Array, number]> => {
      calls += 1;
      throw new Error("always broken");
    };
    let raised = false;
    try {
      await downloadToCache("http://example.invalid/y.json", path.join(tmpdir, "bad.json"), "retry-test", null, () => {}, {
        rangeRaw: broken,
        retryWaitMs: 10,
      });
    } catch {
      raised = true;
    }
    require_(raised, "永久失败时必须抛错，不能当成下载成功");
    require_(calls === 4, `重试次数应为 4（1 次 + 3 次重试），实际调用 ${calls} 次`);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

check(
  "upper_bound_ge_actual_sweep",
  "坑 94/113：随机形状上也不能出现「真实 > 上界」（上界合法性的常驻反例搜索）",
  { needsCtx: true },
)(async () => {
  const ctx = await loadCtx();
  const allIds = [...ctx.servants.values()].map((s) => s.id).sort((a, b) => a - b);
  const rng = makeRng(20261023);
  let shapes = 0;
  let pairs = 0;
  let worstSlack = 0;
  const bad: [number[], number, number][] = [];
  try {
    for (let s = 0; s < UB_SWEEP_SHAPES; s++) {
      const boxIds = rng.sample(allIds, rng.choice([8, 10, 12]));
      const crown = rng.random() < 0.4;
      const raw = {
        box: boxIds.map((sid) => ({
          id: sid,
          stage: rng.choice(["fourth", "third", "second", "initial"]),
          maxBond: rng.random() < 0.15,
          bondSwitch1: rng.random() < 0.8,
          bondSwitch2: rng.random() < 0.3,
        })),
        mode: crown ? "crown" : "normal",
        crownPositions: crown ? ["front_left", "front_right"] : [],
        costLimit: rng.choice([100, 108, 112, 116]),
        topN: 20,
        timeoutMs: UB_SWEEP_BUDGET_MS,
        craftPoolSize: 60,
        // 只测「倍率口径 + baseBond 0」：这样上界与结果行的 totalMultiplier 同量纲
        sortMode: "multiplier",
        strategy: "total_max",
        baseBond: 0,
        activityBonus: rng.choice([0, 0, 0.5]),
      };
      const req = parseRequest(raw);
      const ubByPlayers = new Map<string, number>();
      const hooks: SearchHooks = {
        upperBound: (...args: any[]): number => {
          const v = (relaxedScoreUpperBoundRef as any)(...args);
          const players = args[2] as any[];
          const counted = players.filter((p) => p.counted).map((p) => p.servant_id);
          const key = playersKeyOf(counted);
          if (new Set(counted).size === 5 && v !== undefined) {
            ubByPlayers.set(key, Math.max(ubByPlayers.get(key) ?? -1e18, Number(v)));
          }
          return v;
        },
      };
      const res = await searchTopTeams(ctx, req, null, null, hooks);
      shapes += 1;
      for (const it of res.top20 ?? []) {
        const score = it.totalMultiplier ?? it.multiplier;
        if (score === null || score === undefined) continue;
        const ids = (it.team ?? []).filter((m: any) => !m.isSupport).map((m: any) => Number(m.servantId));
        const key = playersKeyOf(ids);
        const ub = ubByPlayers.get(key);
        if (new Set(ids).size !== 5 || ub === undefined) continue;
        pairs += 1;
        worstSlack = Math.max(worstSlack, ub - Number(score));
        if (Number(score) > ub + 1e-9) bad.push([ids.sort((a, b) => a - b), Number(score), ub]);
      }
    }
  } finally {
    /* 钩子随调用结束，无需还原 */
  }

  require_(pairs >= 20, `可比组太少（${pairs} 组）——预算太小或库不对，判不出合法性`);
  if (bad.length > 0) {
    const worst = bad.reduce((a, b) => (b[1] - b[2] > a[1] - a[2] ? b : a));
    require_(
      false,
      `上界被击穿 ${bad.length} 组（共 ${pairs} 组），最差：真实 ${worst[1].toFixed(4)} > 上界 ${worst[2].toFixed(4)}，阵容 ${worst[0]}`,
    );
  }
  console.log(
    `       · 反例搜索：${shapes} 个形状 / 可比 ${pairs} 组 ／ 反例 0 ／ 最大松弛 ${worstSlack.toFixed(4)}`,
  );
});

function playersKeyOf(ids: number[]): string {
  return [...new Set(ids)].sort((a, b) => a - b).join(",");
}

// ---------------- 确定性 RNG（**不是** Python 的 MT19937：形状序列与 Python 不同，
// 判据是性质本身 —— 0 反例 + 可比组数下限） ----------------
function makeRng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random: next,
    choice<T>(arr: T[]): T {
      return arr[Math.floor(next() * arr.length)];
    },
    sample<T>(arr: T[], k: number): T[] {
      const pool = [...arr];
      const out: T[] = [];
      for (let i = 0; i < k && pool.length > 0; i++) {
        const j = Math.floor(next() * pool.length);
        out.push(pool.splice(j, 1)[0]);
      }
      return out;
    },
  };
}

// ---------------- 运行器 ----------------
type Status = "pass" | "skip" | "xfail" | "fail" | "error";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let only = "";
  for (const a of argv) {
    if (a.startsWith("--only=")) only = a.slice("--only=".length);
  }
  if (argv.includes("--list")) {
    for (const c of CHECKS) {
      console.log(`  ${c.name}${c.knownBroken ? " [known-broken]" : ""}   ${c.doc}`);
    }
    return 0;
  }

  const tally: Record<Status, number> = { pass: 0, skip: 0, xfail: 0, fail: 0, error: 0 };
  const failures: [string, string][] = [];
  console.log(`引擎零件级断言（${CHECKS.length} 项）`);
  console.log("");
  for (const c of CHECKS) {
    if (only && !c.name.includes(only)) continue;
    const t0 = Date.now();
    let status: Status = "pass";
    try {
      if (c.needsCtx) await loadCtx();
      await c.fn();
    } catch (exc: any) {
      if (exc instanceof Skip) {
        status = "skip";
        console.log(`  SKIP  ${c.name}  —— ${exc.message}`);
      } else if (exc instanceof CheckFailed) {
        if (c.knownBroken) {
          status = "xfail";
          console.log(`  XFAIL ${c.name}  —— ${exc.message}`);
        } else {
          status = "fail";
          failures.push([c.name, exc.message]);
          console.log(`  FAIL  ${c.name}  —— ${exc.message}`);
        }
      } else {
        status = "error";
        failures.push([c.name, `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`]);
        console.log(`  ERROR ${c.name}  —— ${exc?.name ?? "Error"}: ${exc?.message ?? exc}`);
        if (exc?.stack) {
          const frames = String(exc.stack).split("\n").slice(1, 4).join("\n          ");
          console.log("          " + frames);
        }
      }
    }
    tally[status] += 1;
    if (status === "pass") {
      const ms = Date.now() - t0;
      console.log(`  PASS  ${c.name}${ms >= 1000 ? `  (${(ms / 1000).toFixed(1)}s)` : ""}`);
    }
  }

  console.log("");
  console.log(`PASS ${tally.pass} ｜ SKIP ${tally.skip} ｜ XFAIL ${tally.xfail} ｜ FAIL ${failures.length}`);
  if (failures.length > 0) {
    console.log("");
    console.log("失败明细：");
    for (const [name, msg] of failures) console.log(`  - ${name}: ${msg}`);
    return 1;
  }
  return 0;
}

export { CHECKS };

const isMain =
  process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("engine-units.ts");
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  });
}
