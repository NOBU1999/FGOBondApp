// P3a：搜索层"素材层"——松弛上界相关的纯函数（对齐 search.py 的 _relaxed_* / 礼装 DP）
import { CalculationRequest } from "./models.ts";
import { CraftInfo, DataContext } from "./calculator.ts";
import { pySum } from "./pysum.ts";

export const GENERIC_UNIVERSAL5_ID = -10;
export const REPEATABLE_BOND_IDS: ReadonlySet<number> = new Set([GENERIC_UNIVERSAL5_ID]);

/** 对齐 search.py 的 `_RelaxedPlayer` */
export class RelaxedPlayer {
  position: string;
  servant_id: number;
  front_factor: number;
  personal_bonus: number;
  aura_bonus: number;
  counted: boolean;
  counts_max_bond: boolean;
  movable: boolean;
  ff_front: number;
  ff_back: number;
  movable_front_slots: number;

  constructor(init: {
    position: string;
    servant_id: number;
    front_factor: number;
    personal_bonus?: number;
    aura_bonus?: number;
    counted?: boolean;
    counts_max_bond?: boolean;
    movable?: boolean;
    ff_front?: number;
    ff_back?: number;
    movable_front_slots?: number;
  }) {
    this.position = init.position;
    this.servant_id = init.servant_id;
    this.front_factor = init.front_factor;
    this.personal_bonus = init.personal_bonus ?? 0;
    this.aura_bonus = init.aura_bonus ?? 0;
    this.counted = init.counted ?? true;
    this.counts_max_bond = init.counts_max_bond ?? false;
    this.movable = init.movable ?? false;
    this.ff_front = init.ff_front ?? 0;
    this.ff_back = init.ff_back ?? 0;
    this.movable_front_slots = init.movable_front_slots ?? 0;
  }
}

export function relaxedTeamConstants(players: RelaxedPlayer[]): [number, number] {
  let maxBondCount = 0;
  for (const p of players) if (p.counts_max_bond) maxBondCount += 1;
  const auraTotal = pySum(players.map((p) => Number(p.aura_bonus || 0)));
  return [maxBondCount, auraTotal];
}

/**
 * Σ 位置系数 × values，其中"可换位的人"按能换到的最有利放位取最大。
 * 重排不等式：位置系数只有前/后两档，前排名额只有 movable_front_slots 个
 * ⇒ 把分值最大的那几个放前排即最大。排序是稳定的（等分保持原顺序）。
 */
export function relaxedMemberSum(players: RelaxedPlayer[], values: number[]): number {
  let total = 0;
  const movable: [number, number, number][] = [];
  let slots = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const v = values[i];
    if (!p.counted) continue;
    if (p.movable) {
      movable.push([Number(v), p.ff_front, p.ff_back]);
      slots = p.movable_front_slots;
    } else {
      total += p.front_factor * v;
    }
  }
  if (movable.length === 0) return total;
  movable.sort((a, b) => b[0] - a[0]);
  for (let i = 0; i < movable.length; i++) {
    const [v, ff, fb] = movable[i];
    total += (i < slots ? ff : fb) * v;
  }
  return total;
}

export function usesPointsScoring(req: CalculationRequest): boolean {
  return req.sort_mode === "points" && Number(req.base_bond || 0) > 0;
}

export function relaxedPercentWeight(req: CalculationRequest): number {
  return usesPointsScoring(req) ? Number(req.base_bond) : 1;
}

export function relaxedBaseScore(
  ctx: DataContext,
  req: CalculationRequest,
  players: RelaxedPlayer[],
): number {
  const [maxBondCount, auraTotal] = relaxedTeamConstants(players);
  const activity = req.activity_bonus || 0;
  const weight = relaxedPercentWeight(req);
  const inners: number[] = [];
  for (const p of players) {
    inners.push(1 + maxBondCount * 0.25 + activity + auraTotal + p.personal_bonus);
  }
  return weight * relaxedMemberSum(players, inners);
}

/** 该从者是否在某个阶段/灵衣下能满足某张特性礼装的条件（ctx 级缓存） */
export function servantCanMatchCraftAnyStage(
  ctx: DataContext,
  servantId: number,
  craft: CraftInfo | null | undefined,
): boolean {
  if (!craft) return false;
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
      for (const groupMask of craft.trigger_masks) {
        if ((mask & groupMask) === groupMask) {
          result = true;
          break outer;
        }
      }
    }
  }
  cache.set(key, result);
  return result;
}

/** 单张玩家位礼装的松弛总分贡献 */
export function relaxedCraftScore(
  ctx: DataContext,
  req: CalculationRequest,
  craft: CraftInfo | null | undefined,
  players: RelaxedPlayer[],
): number {
  if (!craft) return 0;
  const weight = relaxedPercentWeight(req);
  const values: number[] = [];
  let flatScore = 0;
  for (const p of players) {
    if (!p.counted) {
      values.push(0);
      continue;
    }
    let canMatch = craft.bonus_type === "universal";
    if (craft.bonus_type === "trait") {
      canMatch = servantCanMatchCraftAnyStage(ctx, p.servant_id, craft);
    }
    if (craft.bonus_type === "support_only" && craft.bonus_value > 0) canMatch = true;
    if (!canMatch) {
      values.push(0);
      continue;
    }
    values.push(Number(craft.bonus_value));
    flatScore += Number(craft.flat_bonus || 0);
  }
  let score = weight * relaxedMemberSum(players, values);
  if (usesPointsScoring(req)) score += flatScore;
  return score;
}

export function makeCraftScoreMap(
  ctx: DataContext,
  req: CalculationRequest,
  players: RelaxedPlayer[],
  candidateCraftIds: number[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const cid of candidateCraftIds) {
    out.set(cid, relaxedCraftScore(ctx, req, ctx.crafts.get(cid), players));
  }
  return out;
}

export function repeatableCraftIds(ctx: DataContext): Set<number> {
  const anyCtx = ctx as any;
  if (!anyCtx._repeatableIdsCache) {
    const cached = new Set<number>(REPEATABLE_BOND_IDS);
    for (const [cid, craft] of ctx.crafts) if (craft.repeatable) cached.add(cid);
    anyCtx._repeatableIdsCache = cached;
  }
  return anyCtx._repeatableIdsCache;
}

export function comboRelaxedScore(combo: number[], craftScores: Map<number, number>): number {
  let total = 0;
  for (const cid of combo) total += craftScores.get(cid) ?? 0;
  return total;
}

/** 一组自由礼装放在最优物理槽位时的真实 Cost（第二礼装位不消耗 Cost） */
export function craftComboActualCost(
  ctx: DataContext,
  combo: number[],
  zeroCostSlots: boolean[] | null = null,
): number {
  if (combo.length === 0) return 0;
  let zeroCount = 0;
  for (const z of zeroCostSlots ?? []) if (z) zeroCount += 1;
  const costs: number[] = combo.map((cid) => ctx.crafts.get(cid)?.cost ?? 0);
  costs.sort((a, b) => a - b);
  let total = 0;
  for (const c of costs) total += c;
  let discount = 0;
  if (zeroCount > 0) {
    const k = Math.min(costs.length, zeroCount);
    for (let i = costs.length - k; i < costs.length; i++) discount += costs[i];
  }
  return total - discount;
}

/** 礼装组合的最高松弛分（单值背包 DP，无 beam）——只给上界用 */
export function exactBestCraftScore(
  ctx: DataContext,
  candidateCraftIds: number[],
  freeSlotsCount: number,
  costBudget: number,
  repeatableIds: Set<number>,
  zeroCostSlots: boolean[] | null,
  craftScores: Map<number, number>,
): number {
  const candidates = candidateCraftIds.filter((cid) => craftScores.has(cid));
  if (freeSlotsCount <= 0 || candidates.length === 0) return 0;
  let zeroCount = 0;
  for (const z of zeroCostSlots ?? []) if (z) zeroCount += 1;
  let maxCost = 0;
  for (const cid of candidates) {
    const c = ctx.crafts.get(cid)?.cost ?? 0;
    if (c > maxCost) maxCost = c;
  }
  const rawCap = Math.min(
    freeSlotsCount * maxCost,
    Math.max(0, costBudget) + zeroCount * maxCost,
  );
  let dp = new Map<number, number>();
  dp.set(0, 0); // key = used * 100000 + raw
  for (const cid of candidates) {
    const value = craftScores.get(cid) ?? 0;
    if (value <= 0) continue;
    const cost = ctx.crafts.get(cid)?.cost ?? 0;
    if (cost <= 0) continue;
    const maxCopies = repeatableIds.has(cid) ? freeSlotsCount : 1;
    const old = [...dp.entries()];
    for (const [k, score] of old) {
      const used = Math.floor(k / 100000);
      const raw = k % 100000;
      for (let copies = 1; copies <= maxCopies; copies++) {
        const newUsed = used + copies;
        const newRaw = raw + cost * copies;
        if (newUsed > freeSlotsCount || newRaw > rawCap) break;
        const key = newUsed * 100000 + newRaw;
        const cand = score + value * copies;
        const prev = dp.get(key);
        if (prev === undefined || cand > prev) dp.set(key, cand);
      }
    }
  }
  let best = 0;
  let first = true;
  for (const v of dp.values()) {
    if (first || v > best) {
      best = v;
      first = false;
    }
  }
  return first ? 0 : best;
}

/** 固定阵容下的礼装 DP：返回少量有希望的 (Cost, 组合)，每状态留 top_k */
export function dpTopCraftCombinations(
  ctx: DataContext,
  candidateCraftIds: number[],
  freeSlotsCount: number,
  costBudget: number,
  repeatableIds: Set<number>,
  zeroCostSlots: boolean[] | null,
  craftScores: Map<number, number>,
  topK = 10,
): [number, number[]][] {
  const candidates = candidateCraftIds.filter((cid) => craftScores.has(cid));
  if (freeSlotsCount <= 0 || candidates.length === 0) return [[0, []]];

  let zeroCount = 0;
  for (const z of zeroCostSlots ?? []) if (z) zeroCount += 1;
  let maxCraftCost = 0;
  for (const cid of candidates) {
    const c = ctx.crafts.get(cid)?.cost ?? 0;
    if (c > maxCraftCost) maxCraftCost = c;
  }
  const rawCap = Math.min(
    freeSlotsCount * maxCraftCost,
    Math.max(0, costBudget) + zeroCount * maxCraftCost,
  );

  const dp = new Map<number, [number, number[]][]>();
  dp.set(0, [[0, []]]);

  function addEntry(used: number, raw: number, score: number, combo: number[]): void {
    const k = used * 100000 + raw;
    let arr = dp.get(k);
    if (arr === undefined) {
      arr = [];
      dp.set(k, arr);
    }
    let i = 0;
    const n = arr.length;
    while (i < n && arr[i][0] >= score) i++;
    arr.splice(i, 0, [score, combo]);
    if (arr.length > topK) arr.pop();
  }

  for (const cid of candidates) {
    const craftCost = ctx.crafts.get(cid)?.cost ?? 0;
    const singleValue = craftScores.get(cid) ?? 0;
    if (singleValue <= 0) continue;
    const maxCopies = repeatableIds.has(cid) ? freeSlotsCount : 1;
    const oldItems = [...dp.entries()];
    for (const [k, entries] of oldItems) {
      const used = Math.floor(k / 100000);
      const rawCost = k % 100000;
      for (const [baseScore, baseCombo] of entries) {
        if (!repeatableIds.has(cid) && baseCombo.includes(cid)) continue;
        for (let copies = 1; copies <= maxCopies; copies++) {
          const newUsed = used + copies;
          if (newUsed > freeSlotsCount) break;
          const newRaw = rawCost + craftCost * copies;
          if (newRaw > rawCap) break;
          const nc = baseCombo.slice();
          for (let t = 0; t < copies; t++) nc.push(cid);
          addEntry(newUsed, newRaw, baseScore + singleValue * copies, nc);
        }
      }
    }
  }

  const results: [number, number, number[]][] = [];
  for (const [k, entries] of dp.entries()) {
    const used = Math.floor(k / 100000);
    if (used > freeSlotsCount) continue;
    for (const [score, combo] of entries) {
      const counts = new Map<number, number>();
      let ok = true;
      for (const cid of combo) {
        const c = (counts.get(cid) ?? 0) + 1;
        counts.set(cid, c);
        if (c > 1 && !repeatableIds.has(cid)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const realCost = craftComboActualCost(ctx, combo, zeroCostSlots);
      if (realCost <= costBudget) results.push([score, realCost, combo]);
    }
  }
  results.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return results.slice(0, topK).map((r) => [r[1], r[2]] as [number, number[]]);
}
