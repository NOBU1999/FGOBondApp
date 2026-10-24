// P3b-2：候选池 / 支配与规范化 / 采样 / 礼装组合 / 助战候选
import { pySum } from "./pysum.ts";
import { POSITIONS, type BoxServant, type CalculationRequest } from "./models.ts";
import { type DataContext, traitBenefitTable } from "./calculator.ts";
import { craftComboActualCost, repeatableCraftIds } from "./relaxed.ts";
import {
  GENERIC_BOND_CRAFT_IDS,
  clusterBonus,
  isOumaCraft,
  maxPossibleTraitBonus,
  servantHeuristic,
  traitCraftIds,
  traitShareWeight,
} from "./teamBuild.ts";

// ---------------------------------------------------------------------------
// 组合数（C(n,k)，与 Python math.comb 同值）
// ---------------------------------------------------------------------------
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

// ---------------------------------------------------------------------------
// 支配关系 / 规范化（值优先剪枝）
// ---------------------------------------------------------------------------
function craftStageSets(ctx: DataContext, servantId: number, traitIds: number[]): Set<string> {
  const info = ctx.servants.get(servantId);
  const sets = new Set<string>();
  if (!info || Object.keys(info.traits).length === 0) {
    sets.add("");
    return sets;
  }
  for (const key of Object.keys(info.traits)) {
    const mask = info.mask_for(key);
    if (mask === 0n) {
      sets.add("");
      continue;
    }
    const hit: number[] = [];
    for (const cid of traitIds) {
      const craft = ctx.crafts.get(cid);
      if (!craft) continue;
      if (craft.trigger_masks.some((gm) => (mask & gm) === gm)) hit.push(cid);
    }
    hit.sort((a, b) => a - b);
    sets.add(hit.join(","));
  }
  return sets;
}

/** x 支配 y ⇒ 含 y 不含 x 的阵容可换成 x（可证明不更差） */
export function dominanceMap(
  ctx: DataContext,
  box: Map<number, BoxServant>,
  candidateIds: number[],
  traitIds: number[],
): Map<number, Set<number>> {
  const fams = new Map<number, Set<string>>();
  for (const sid of candidateIds) fams.set(sid, craftStageSets(ctx, sid, traitIds));
  const dom = new Map<number, Set<number>>();
  for (const y of candidateIds) {
    const by = box.get(y);
    const ys = ctx.servants.get(y);
    if (!by || !ys) continue;
    const doms = new Set<number>();
    for (const x of candidateIds) {
      if (x === y) continue;
      const bx = box.get(x);
      const xs = ctx.servants.get(x);
      if (!bx || !xs || xs.cost > ys.cost) continue;
      if (bx.personal_bonus < by.personal_bonus || bx.aura_bonus < by.aura_bonus) continue;
      if (by.count_personal_bond && !bx.count_personal_bond) continue;
      if (by.count_in_team_bonus && !bx.count_in_team_bonus) continue;
      // ∀ my ∈ fam(y), ∃ mx ∈ fam(x) s.t. my ⊆ mx
      let ok = true;
      for (const my of fams.get(y)!) {
        let covered = false;
        for (const mx of fams.get(x)!) {
          if (isSubset(my, mx)) {
            covered = true;
            break;
          }
        }
        if (!covered) {
          ok = false;
          break;
        }
      }
      if (ok) doms.add(x);
    }
    if (doms.size > 0) dom.set(y, doms);
  }
  return dom;
}

function isSubset(a: string, b: string): boolean {
  if (a === "") return true;
  if (b === "") return false;
  const setB = new Set(b.split(","));
  for (const x of a.split(",")) if (!setB.has(x)) return false;
  return true;
}

export function canonicalMap(
  candidateIds: number[],
  domBy: Map<number, Set<number>>,
): Map<number, number> {
  const idx = new Map<number, number>();
  candidateIds.forEach((sid, i) => idx.set(sid, i));
  const parent = new Map<number, number>();
  for (const sid of candidateIds) parent.set(sid, sid);

  const find = (a: number): number => {
    while (parent.get(a)! !== a) {
      parent.set(a, parent.get(parent.get(a)!)!);
      a = parent.get(a)!;
    }
    return a;
  };

  for (const [y, doms] of domBy) {
    if (!parent.has(y)) continue;
    for (const x of doms) {
      if (!parent.has(x) || !(domBy.get(x)?.has(y) ?? false)) continue;
      const ry = find(y), rx = find(x);
      if (ry === rx) continue;
      if (idx.get(ry)! <= idx.get(rx)!) parent.set(rx, ry);
      else parent.set(ry, rx);
    }
  }

  const members = new Map<number, number[]>();
  for (const sid of candidateIds) {
    const r = find(sid);
    if (!members.has(r)) members.set(r, []);
    members.get(r)!.push(sid);
  }
  const canon = new Map<number, number>();
  for (const sid of candidateIds) {
    const group = members.get(find(sid))!;
    canon.set(sid, group.reduce((best, m) => (idx.get(m)! < idx.get(best)! ? m : best)));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const sid of candidateIds) {
      const doms = domBy.get(sid);
      if (!doms || doms.size === 0) continue;
      let cand = Infinity;
      for (const x of doms) {
        const v = idx.get(canon.get(x) ?? x) ?? 1 << 30;
        if (v < cand) cand = v;
      }
      const cur = idx.get(canon.get(sid)!) ?? 1 << 30;
      if (cand < cur) {
        // 找到那个代表
        let pick = sid;
        let bestIdx = Infinity;
        for (const x of doms) {
          const rep = canon.get(x) ?? x;
          const v = idx.get(rep) ?? 1 << 30;
          if (v < bestIdx) {
            bestIdx = v;
            pick = rep;
          }
        }
        canon.set(sid, pick);
        changed = true;
      }
    }
  }
  return canon;
}

export function canonicalCombo(
  combo: number[],
  domBy: Map<number, Set<number>>,
  canon: Map<number, number>,
): number[] {
  const out = [...combo];
  for (let round = 0; round <= out.length; round++) {
    let changed = false;
    for (let i = 0; i < out.length; i++) {
      const sid = out[i];
      const doms = domBy.get(sid);
      if (!doms || doms.size === 0) continue;
      let anyIn = false;
      for (const x of doms) if (out.includes(x)) { anyIn = true; break; }
      if (anyIn) continue;
      const rep = canon.get(sid);
      if (rep === undefined || rep === sid || out.includes(rep)) continue;
      out[i] = rep;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  out.sort((a, b) => a - b);
  return out;
}

export function canonicalizeList(
  combos: number[][],
  domBy: Map<number, Set<number>>,
  canon: Map<number, number>,
): number[][] {
  if (domBy.size === 0 || canon.size === 0) return combos.map((c) => [...c]);
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const combo of combos) {
    const rep = canonicalCombo(combo, domBy, canon);
    const key = rep.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(rep);
    }
  }
  return out;
}

export function canonicalizeRefill(
  picked: number[][],
  combos: number[][],
  limit: number,
  domBy: Map<number, Set<number>> | null,
  canon: Map<number, number> | null,
): number[][] {
  const out = canonicalizeList(picked, domBy ?? new Map(), canon ?? new Map());
  if (!domBy || !canon || domBy.size === 0 || canon.size === 0 || out.length >= limit) return out;
  const seen = new Set(out.map((c) => c.join(",")));
  for (const combo of combos) {
    if (out.length >= limit) break;
    const rep = canonicalCombo(combo, domBy, canon);
    const key = rep.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rep);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 从者组合：生成 / 采样
// ---------------------------------------------------------------------------
export function generateServantCombinations(
  candidateIds: number[],
  chooseCount: number,
): number[][] {
  if (chooseCount === 0) return [[]];
  const out: number[][] = [];
  const n = candidateIds.length;
  if (chooseCount > n) return out;
  const idx = Array.from({ length: chooseCount }, (_, i) => i);
  while (true) {
    out.push(idx.map((i) => candidateIds[i]));
    let i = chooseCount - 1;
    while (i >= 0 && idx[i] === n - chooseCount + i) i--;
    if (i < 0) break;
    idx[i] += 1;
    for (let j = i + 1; j < chooseCount; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

export function lineupTraitPotential(
  ctx: DataContext,
  lineup: number[],
  traitIds: number[],
  craftSlots: number,
): number {
  if (lineup.length === 0 || traitIds.length === 0) return 0;
  const table = traitBenefitTable(ctx);
  const contribs: number[] = [];
  for (const cid of traitIds) {
    const value = table.craftValue(cid);
    if (value <= 0) continue;
    let n = 0;
    for (const sid of lineup) if (table.canTrigger(sid, cid)) n += 1;
    if (n) contribs.push(value * n);
  }
  if (contribs.length === 0) return 0;
  contribs.sort((a, b) => b - a);
  const take = craftSlots > 0 && contribs.length > craftSlots ? contribs.slice(0, craftSlots) : contribs;
  return pySum(take);
}

export function sampleServantCombinations(
  candidateIds: number[],
  chooseCount: number,
  limit: number,
  ctx: DataContext | null = null,
  traitIds: number[] | null = null,
  craftSlots = 5,
  dualPass = false,
  domBy: Map<number, Set<number>> | null = null,
  canon: Map<number, number> | null = null,
): number[][] {
  const combos = generateServantCombinations(candidateIds, chooseCount);
  if (combos.length <= limit) return canonicalizeList(combos, domBy ?? new Map(), canon ?? new Map());

  if (!ctx || !traitIds || traitIds.length === 0) {
    const step = combos.length / Math.max(1, limit);
    const picked: number[][] = [];
    for (let i = 0; i < limit; i++) picked.push(combos[Math.floor(i * step)]);
    return canonicalizeRefill(picked, combos, limit, domBy, canon);
  }

  const qualityBudget = dualPass ? Math.max(1, Math.floor(limit / 2)) : limit;
  // Python: sorted(combos, key=potential, reverse=True) —— 稳定
  const keyOf = new Map<string, number>();
  const pot = (c: number[]) => {
    const k = c.join(",");
    let v = keyOf.get(k);
    if (v === undefined) {
      v = lineupTraitPotential(ctx, c, traitIds, craftSlots);
      keyOf.set(k, v);
    }
    return v;
  };
  const ranked = [...combos].sort((a, b) => pot(b) - pot(a));
  const picked = ranked.slice(0, qualityBudget);
  if (!dualPass) return canonicalizeRefill(picked, combos, limit, domBy, canon);

  const strideBudget = limit - picked.length;
  const step = combos.length / Math.max(1, strideBudget);
  const seen = new Set(picked.map((c) => c.join(",")));
  for (let i = 0; i < strideBudget; i++) {
    const cand = combos[Math.floor(i * step)];
    const k = cand.join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(cand);
  }
  return canonicalizeRefill(picked, combos, limit, domBy, canon);
}

// ---------------------------------------------------------------------------
// 候选池压缩
// ---------------------------------------------------------------------------
export function reduceCandidateIds(
  ctx: DataContext,
  candidates: number[],
  chooseCount: number,
  maxCombos: number,
  box: Map<number, BoxServant>,
  traitIds: number[],
): number[] {
  if (chooseCount <= 0) return [...candidates];
  const share = traitShareWeight(ctx, candidates, traitIds);
  const scored = [...candidates].sort(
    (a, b) =>
      servantHeuristic(ctx, box.get(b)!, traitIds) +
      clusterBonus(share, b) -
      (servantHeuristic(ctx, box.get(a)!, traitIds) + clusterBonus(share, a)),
  );
  let k = scored.length;
  while (k > chooseCount && comb(k, chooseCount) > maxCombos) k -= 1;
  return scored.slice(0, k);
}

// ---------------------------------------------------------------------------
// 礼装组合
// ---------------------------------------------------------------------------
function combinationsWithReplacement(ids: number[], size: number): number[][] {
  const out: number[][] = [];
  const n = ids.length;
  if (size === 0) return [[]];
  if (n === 0) return out;
  const idx = new Array(size).fill(0);
  while (true) {
    out.push(idx.map((i: number) => ids[i]));
    let i = size - 1;
    while (i >= 0 && idx[i] === n - 1) i--;
    if (i < 0) break;
    const v = idx[i] + 1;
    for (let j = i; j < size; j++) idx[j] = v;
  }
  return out;
}

export function generateCraftCombinationsWithCost(
  ctx: DataContext,
  candidateCraftIds: number[],
  freeSlotsCount: number,
  maxTotal = 200000,
  zeroCostSlots: boolean[] | null = null,
): [number, number[]][] {
  if (freeSlotsCount <= 0) return [[0, []]];
  const zero = [...(zeroCostSlots ?? [])];
  const result: [number, number[]][] = [];
  const seen = new Set<string>();
  const comboCost = (c: number[]) => craftComboActualCost(ctx, c, zero);

  const candidateIds = [...candidateCraftIds];
  const cheapestIds = [...candidateIds].sort(
    (a, b) => (ctx.crafts.get(a)?.cost ?? 0) - (ctx.crafts.get(b)?.cost ?? 0),
  );
  const maxSize = freeSlotsCount;

  for (let size = 1; size <= maxSize; size++) {
    for (const target of candidateIds) {
      if (result.length >= maxTotal) break;
      const parts = [target];
      for (const cid of cheapestIds) {
        if (parts.length >= size) break;
        if (cid !== target) parts.push(cid);
      }
      if (parts.length < size && !candidateIds.includes(-10)) continue;
      while (parts.length < size) parts.push(-10);
      const c = [...parts].sort((a, b) => a - b);
      const cost = comboCost(c);
      const key = `${cost}|${c.join(",")}`;
      if (!seen.has(key)) {
        result.push([cost, c]);
        seen.add(key);
      }
    }
  }

  const repIds = repeatableCraftIds(ctx);
  let stopped = false;
  for (let size = maxSize; size >= 0; size--) {
    for (const c of combinationsWithReplacement(candidateIds, size)) {
      const counts = new Map<number, number>();
      let ok = true;
      for (const cid of c) {
        const n = (counts.get(cid) ?? 0) + 1;
        counts.set(cid, n);
        if (n > 1 && !repIds.has(cid)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const cost = comboCost(c);
      const key = `${cost}|${c.join(",")}`;
      if (!seen.has(key)) {
        result.push([cost, [...c]]);
        seen.add(key);
      }
      if (result.length >= maxTotal) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }

  if (!seen.has(`0|`)) {
    result.push([0, []]);
    seen.add(`0|`);
  }

  result.sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  return result;
}

// ---------------------------------------------------------------------------
// 助战候选
// ---------------------------------------------------------------------------
export function isEventLimitedCraft(ctx: DataContext, craftId: number): boolean {
  const craft = ctx.crafts.get(craftId);
  if (!craft) return false;
  if (craft.is_event_limited) return true;
  const low = (craft.detail ?? "").toLowerCase();
  return ["活动限定", "event only", "event limited", "イベント限定"].some((m) => low.includes(m));
}

export function isMergedGenericUniversal5(ctx: DataContext, craftId: number): boolean {
  const craft = ctx.crafts.get(craftId);
  if (!craft) return false;
  return (
    craftId !== -10 &&
    craft.is_bond_ce &&
    !craft.is_custom &&
    craft.bonus_type === "universal" &&
    Math.abs(craft.bonus_value - 0.05) < 1e-9 &&
    craft.support_bonus <= 0
  );
}

export function autoSupportCraftOptions(ctx: DataContext, req: CalculationRequest): number[] {
  const options: number[] = [];
  for (const [cid, craft] of ctx.crafts) {
    if (!craft.is_bond_ce) continue;
    if (req.support_excluded_craft_ids.has(cid)) continue;
    if (isEventLimitedCraft(ctx, cid)) continue;
    if (isOumaCraft(ctx, cid)) continue;
    if (isMergedGenericUniversal5(ctx, cid)) continue;
    if (
      !(
        craft.bonus_value > 0.025 ||
        craft.support_bonus > 0.025 ||
        craft.flat_bonus > 0 ||
        GENERIC_BOND_CRAFT_IDS.has(cid)
      )
    )
      continue;
    options.push(cid);
  }
  options.sort((a, b) => {
    const ca = ctx.crafts.get(a)!, cb = ctx.crafts.get(b)!;
    const ka = ca.bonus_type !== "universal" ? 1 : 0;
    const kb = cb.bonus_type !== "universal" ? 1 : 0;
    if (ka !== kb) return ka - kb;
    if (ca.bonus_value !== cb.bonus_value) return cb.bonus_value - ca.bonus_value;
    return cb.support_bonus - ca.support_bonus;
  });
  return options.slice(0, req.craft_pool_size + 1);
}

export function supportCraftOptions(ctx: DataContext, req: CalculationRequest): number[] {
  if (req.support && req.support.craft_id !== null) {
    const cid = req.support.craft_id;
    return ctx.crafts.has(cid) ? [cid] : [];
  }
  return autoSupportCraftOptions(ctx, req);
}

export function filterSupportOptionsForTeam(
  ctx: DataContext,
  options: number[],
  playerIds: number[],
): number[] {
  const anyCtx = ctx as any;
  if (!anyCtx._supportFilterCache) anyCtx._supportFilterCache = new Map<string, number[]>();
  const cache: Map<string, number[]> = anyCtx._supportFilterCache;
  const sortedPlayers = [...playerIds].sort((a, b) => a - b);
  const ckey = `${options.join(",")}|${sortedPlayers.join(",")}`;
  const hit = cache.get(ckey);
  if (hit !== undefined) return [...hit];

  const result: number[] = [];
  const traitScores: [number, number, number][] = [];
  const playerSet = new Set(playerIds);
  for (const cid of options) {
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    if (isOumaCraft(ctx, cid)) continue;
    if (!craft.is_bond_ce && craft.bonus_type === null) {
      result.push(cid);
      continue;
    }
    if (craft.support_bonus > 0) {
      result.push(cid);
      continue;
    }
    if (craft.flat_bonus > 0) {
      result.push(cid);
      continue;
    }
    if (GENERIC_BOND_CRAFT_IDS.has(cid)) {
      result.push(cid);
      continue;
    }
    if (craft.bonus_type === "universal" && craft.bonus_value >= 0.1) {
      result.push(cid);
      continue;
    }
    if (craft.bonus_type === "support_only") {
      result.push(cid);
      continue;
    }
    if (craft.bonus_type === "trait") {
      let count = 0;
      for (const sid of playerSet) {
        if (servantCanMatchAny(ctx, sid, craft)) count += 1;
      }
      if (count > 0) traitScores.push([count, craft.bonus_value, cid]);
    }
  }
  traitScores.sort((a, b) => b[0] - a[0] || b[1] - a[1] || a[2] - b[2]);
  for (const [, , cid] of traitScores.slice(0, 2)) result.push(cid);
  cache.set(ckey, [...result]);
  return result;
}

function servantCanMatchAny(ctx: DataContext, servantId: number, craft: any): boolean {
  const anyCtx = ctx as any;
  if (!anyCtx._anyStageMatchCache) anyCtx._anyStageMatchCache = new Map<string, boolean>();
  const cache: Map<string, boolean> = anyCtx._anyStageMatchCache;
  const key = `${servantId}:${craft.id}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const info = ctx.servants.get(servantId);
  let result = false;
  if (info && Object.keys(info.traits).length > 0) {
    outer: for (const stateKey of Object.keys(info.traits)) {
      const mask = info.mask_for(stateKey);
      for (const gm of craft.trigger_masks) {
        if ((mask & gm) === gm) {
          result = true;
          break outer;
        }
      }
    }
  }
  cache.set(key, result);
  return result;
}

export { traitCraftIds, maxPossibleTraitBonus, POSITIONS };
