// P3b-2 主流程：对齐 search.py::search_top_teams 及其周边辅助
// （两轮粗搜 / best-first + cutoff / 精算 / 邻域换人 / 同分替补 / 结果组装）
//
// 判据是逐字节。几个必须照抄的点：
//  · 所有 Python 的 sum() 一律 pySum（Neumaier 补偿）；
//  · round() 一律 pyRound（银行家舍入）；
//  · set(itertools.permutations(...)) 的遍历顺序用 pyPermutationSetOrder 复刻
//    —— _optimize_free_positions 只接受"严格更优"，并列最优时留下的是**迭代顺序里第一个**；
//  · 集合/字典的迭代顺序只在与输出有关的地方复刻（dict/set 仅做成员判断的地方不必）。
import {
  CalculationRequest,
  FRONT_POSITIONS,
  POSITIONS,
  STRATEGY_BALANCED,
  STRATEGY_TARGET_MAX,
  STRATEGY_TOTAL_MAX,
  type BoxServant,
} from "./models.ts";
import {
  DataContext,
  type CraftInfo,
  traitBenefitTable,
} from "./calculator.ts";
import {
  PlacedMember,
  TeamConfig,
  calculateTeamMetrics,
  flatBonusForMask,
  frontlineBonus,
  optimizeTeamStages,
  teamCost,
  traitBonusForMask,
  type TeamMetrics,
} from "./team.ts";
import { evaluateTeam, pyRound } from "./evaluate.ts";
import { pySum } from "./pysum.ts";
import { getPlatform } from "./platform.ts";
import {
  RelaxedPlayer,
  craftComboActualCost,
  dpTopCraftCombinations,
  exactBestCraftScore,
  makeCraftScoreMap,
  relaxedBaseScore,
  relaxedCraftScore,
  relaxedPercentWeight,
  repeatableCraftIds,
  servantCanMatchCraftAnyStage,
  usesPointsScoring,
} from "./relaxed.ts";
import {
  Blueprint,
  GENERIC_BOND_CRAFT_IDS,
  boxMap,
  clusterBonus,
  fillRemainingCraftSlots,
  greedyMapping,
  isOumaCraft,
  makeTeamConfig,
  mergeCraftAssignment,
  servantHeuristic,
  servantInClassGroup,
  traitCraftIds,
  traitShareWeight,
} from "./teamBuild.ts";
import { prepareBlueprint } from "./blueprint.ts";
import {
  autoSupportCraftOptions,
  canonicalCombo,
  canonicalMap,
  comb,
  dominanceMap,
  filterSupportOptionsForTeam,
  generateCraftCombinationsWithCost,
  generateServantCombinations,
  isMergedGenericUniversal5,
  isEventLimitedCraft,
  reduceCandidateIds,
  sampleServantCombinations,
  supportCraftOptions,
} from "./pool.ts";
import { pyPermutationSetOrder } from "./pyset.ts";

// ---------------------------------------------------------------------------
// 档位推导（对齐 search.py 885~1090）
// ---------------------------------------------------------------------------
const SUPER_BUDGET_SECONDS = 3600.0;
const MAX_COMBOS_PER_ROUND = 40000;

export const POSFIX_ENUM_ROWS = 50;
export const ALT_CAP = 500;
export const EVENT_GUARANTEE_CAP = 5;
export const EVENT_GUARANTEE_FLOOR_ALWAYS = 0.5;
export const EVENT_GUARANTEE_FLOOR_OPTIONAL = 0.2;

/** 超级模式的覆盖倍数（1.0 = 普通档位） */
export function superMult(req: CalculationRequest): number {
  const raw = Number((req as any).super_mode ?? 0) || 0;
  return raw > 1.0 ? raw : 1.0;
}

export function superEnabled(req: CalculationRequest): boolean {
  return superMult(req) > 1.0;
}

export function timeBudgetSeconds(req: CalculationRequest): number {
  if (superEnabled(req)) return Math.max(SUPER_BUDGET_SECONDS, req.timeout_ms / 1000.0);
  return Math.max(1.0, req.timeout_ms / 1000.0);
}

function combosBudgetFor(req: CalculationRequest): number {
  const seconds = timeBudgetSeconds(req);
  return Math.trunc(Math.max(1200, seconds * 2000 * 0.6));
}

function maxCombosPerRound(req: CalculationRequest): number {
  return Math.trunc(MAX_COMBOS_PER_ROUND * superMult(req));
}

export function defaultServantComboLimit(req: CalculationRequest, chooseCount = 5): number {
  const choose = Math.max(1, chooseCount);
  const budget = Math.min(combosBudgetFor(req), maxCombosPerRound(req));
  let k = choose;
  while (comb(k + 1, choose) <= budget) k += 1;
  return Math.max(600, comb(k, choose));
}

export function defaultSweepLimit(req: CalculationRequest, chooseCount = 5): number {
  const choose = Math.max(1, chooseCount);
  const budget = Math.min(combosBudgetFor(req), maxCombosPerRound(req));
  let k = choose;
  while (comb(k + 1, choose) <= budget) k += 1;
  if (comb(k, choose) <= budget) return comb(k, choose);
  return budget;
}

export function defaultCraftComboLimit(req: CalculationRequest): number {
  const dynamic = Math.trunc(timeBudgetSeconds(req) * 200);
  return Math.max(4000, Math.min(Math.trunc(12000 * superMult(req)), dynamic));
}

export function defaultRefineCount(req: CalculationRequest, poolSize: number): number {
  const byBudget = Math.max(2, Math.trunc((timeBudgetSeconds(req) * 0.3) / 0.35));
  return Math.max(2, Math.min(Math.trunc(Math.min(100, 15 * superMult(req))), poolSize, byBudget));
}

export function defaultTripRecheckCount(req: CalculationRequest): number {
  let base = Math.max(256, Math.min(2048, Math.trunc(timeBudgetSeconds(req) / 8.0)));
  if (superMult(req) > 1) base = Math.min(8192, base * 4);
  return base;
}

export function defaultNeighborRefineCount(req: CalculationRequest): number {
  const byBudget = Math.max(4, Math.trunc(timeBudgetSeconds(req) / 12.0));
  return Math.max(4, Math.min(Math.trunc(16 * superMult(req)), byBudget));
}

/** 是否对精算阵容再做一次自由位全排列优化（Python 侧恒为 True） */
export function optimizeFreePositionsEnabled(): boolean {
  return true;
}

export function defaultCraftSetLineupBudget(req: CalculationRequest): number {
  const mult = superMult(req);
  let seconds = Math.max(1.0, Number((req as any).timeout_ms ?? 60000) / 1000.0);
  if (superEnabled(req)) seconds = Math.max(SUPER_BUDGET_SECONDS, seconds);
  return Math.trunc(Math.max(600, Math.min(Math.trunc(24000 * mult), seconds * 40 * mult)));
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export class SearchCancelled extends Error {}

/** 测试注入点（生产调用不传）。只给零件级断言用：替换上界函数，其余逻辑一字不动。 */
export interface SearchHooks {
  upperBound?: (...args: Parameters<typeof relaxedScoreUpperBound>) => number;
  /**
   * 每次算完一套阵容的上界后回调，给"合法性硬检查"用：`ub` = 现在用的精确界（T2），
   * `cheap` = 光看"Σ 前 K 大礼装项"的便宜界（T1）。理论上恒有 `cheap ≥ ub`；
   * 断言它、并统计"按 cheap 剪枝还能活下来多少"，就是决定要不要把 T1 接到主循环之前的唯一依据。
   */
  onBound?: (info: {
    ub: number;
    cheap: number;
    /** 该阵容的"每张礼装松弛分"（诊断 gap 用） */
    craftScores: Map<number, number>;
    freeSlots: number;
    costBudget: number;
    zeroCostSlots: boolean[] | null;
  }) => void;
  /**
   * 每隔多少毫秒「让出一次事件循环」。
   *
   * 只给**网页宿主**用（安卓 WebView 的 Worker）：那边点"停止"是主线程 postMessage 过来，
   * 而搜索是同步大循环 —— 不让出事件循环就永远收不到消息，停止按钮等于失效。
   * 让出之后 `shouldCancel` 回调立刻能读到新状态，引擎照旧体面收尾（`status: "partial"`）。
   *
   * 桌面不传（0）：那边 `shouldCancel` 是同步读停止文件，让出反而白费时间。
   * 让出**不改变任何计算**（不读时钟做决策、不动随机数），只是把控制权交还事件循环。
   */
  yieldEveryMs?: number;
}

/** 调试计数（只在 FGO_DEBUG 打开时累积；闸门定位用，正常路径不读） */

function nowSec(): number {
  return Date.now() / 1000;
}

function sortedKey(ids: Iterable<number>): string {
  return [...ids].sort((a, b) => a - b).join(",");
}

function sortedUniqueNums(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** bisect.insort（insort_right）：等值插在后面 */
function insort(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

/** bisect_left + 等值删除一个 */
function removeOne(arr: number[], value: number): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo < arr.length && arr[lo] === value) arr.splice(lo, 1);
}

function rankKeyGreater(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}

/** itertools.combinations 顺序 */
function* combinations<T>(items: T[], k: number): Generator<T[]> {
  const n = items.length;
  if (k < 0 || k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k === 0) {
    yield [];
    return;
  }
  for (;;) {
    yield idx.map((i) => items[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** itertools.product 顺序（最后一个变化最快） */
function* product(choices: number[][]): Generator<number[]> {
  const n = choices.length;
  if (n === 0) {
    yield [];
    return;
  }
  for (const c of choices) if (c.length === 0) return;
  const idx = new Array(n).fill(0);
  for (;;) {
    yield idx.map((v, j) => choices[j][v]);
    let p = n - 1;
    while (p >= 0) {
      idx[p] += 1;
      if (idx[p] < choices[p].length) break;
      idx[p] = 0;
      p -= 1;
    }
    if (p < 0) return;
  }
}

// ---------------------------------------------------------------------------
// 助战选择 / 特性协同（对齐 _choose_support、_matches_any_trait_craft、_multi_trait_count）
// ---------------------------------------------------------------------------
export function chooseSupport(
  ctx: DataContext,
  req: CalculationRequest,
  _usedServantIds: Set<number>,
  _box: Map<number, BoxServant>,
): number | null {
  const anyReq = req as any;
  let key = anyReq._supportChoiceKey as string | undefined;
  if (key === undefined) {
    const supportId = req.support ? req.support.servant_id : null;
    key = `${supportId}|${req.class_group ?? ""}|${sortedKey(req.excluded_servant_ids)}`;
    anyReq._supportChoiceKey = key;
  }
  const anyCtx = ctx as any;
  if (!anyCtx._supportChoiceCache) anyCtx._supportChoiceCache = new Map<string, number | null>();
  const cache: Map<string, number | null> = anyCtx._supportChoiceCache;
  if (cache.has(key)) return cache.get(key)!;

  if (req.support && req.support.servant_id !== null) {
    const sid = req.support.servant_id;
    const result =
      ctx.servants.has(sid) && servantInClassGroup(ctx, sid, req.class_group) ? sid : null;
    cache.set(key, result);
    return result;
  }
  let best: number | null = null;
  for (const sid of ctx.servants.keys()) {
    if (req.excluded_servant_ids.has(sid)) continue;
    if (!servantInClassGroup(ctx, sid, req.class_group)) continue;
    if (best === null || sid < best) best = sid;
  }
  cache.set(key, best);
  return best;
}

export function matchesAnyTraitCraft(
  ctx: DataContext,
  servantId: number,
  craftIds: number[],
): boolean {
  for (const cid of craftIds) {
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    if (servantCanMatchCraftAnyStage(ctx, servantId, craft)) return true;
  }
  return false;
}

export function multiTraitCount(ctx: DataContext, servantId: number, traitIds: number[]): number {
  let n = 0;
  for (const cid of traitIds) {
    if (servantCanMatchCraftAnyStage(ctx, servantId, ctx.crafts.get(cid))) n += 1;
  }
  return n;
}

/** 某从者在"这套礼装"下能达到的最大（特性%合计, 固定值合计） */
export function servantCraftEffectMax(
  ctx: DataContext,
  servantId: number,
  crafts: (CraftInfo | null | undefined)[],
): [number, number] {
  const info = ctx.servants.get(servantId);
  if (!info || Object.keys(info.traits).length === 0) return [0, 0];
  const list = crafts.filter((c): c is CraftInfo => Boolean(c));
  let best: [number, number] = [0, 0];
  for (const stageKey of Object.keys(info.traits)) {
    const mask = info.mask_for(stageKey);
    if (mask === 0n) continue;
    const pct = traitBonusForMask(mask, list);
    const flat = flatBonusForMask(mask, list);
    if (pct > best[0] || (pct === best[0] && flat > best[1])) best = [pct, flat];
  }
  return best;
}

// ---------------------------------------------------------------------------
// 松弛上界（对齐 _relaxed_players_from_mapping / _relaxed_support_craft_score /
// _support_max_relaxed_add / _prepare_dp_craft_combos_for_team / _relaxed_score_upper_bound）
// ---------------------------------------------------------------------------
export function relaxedPlayersFromMapping(
  ctx: DataContext,
  req: CalculationRequest,
  bp: Blueprint,
  box: Map<number, BoxServant>,
  mapping: Map<string, number>,
): RelaxedPlayer[] {
  const players: RelaxedPlayer[] = [];
  const supportInFront = bp.support_position !== null && FRONT_POSITIONS.has(bp.support_position);
  const freePositions = new Set(bp.free_servant_positions);
  let ffFront = 0;
  for (const pos of FRONT_POSITIONS) {
    ffFront = Math.max(ffFront, frontlineBonus(pos, supportInFront));
  }
  ffFront = 1.0 + ffFront;
  const backPositions = POSITIONS.filter((pos) => !FRONT_POSITIONS.has(pos));
  const ffBack = 1.0 + frontlineBonus(backPositions[0], supportInFront);
  let movableFrontSlots = 0;
  for (const pos of freePositions) if (FRONT_POSITIONS.has(pos)) movableFrontSlots += 1;

  for (const slot of bp.player_slots) {
    let sid: number | null = slot.fixed_servant_id;
    if (sid === null) {
      const mapped = mapping.get(slot.position);
      sid = mapped === undefined ? null : mapped;
    }
    if (sid === null) continue;
    const bs = box.get(sid);
    if (!bs) continue;
    players.push(
      new RelaxedPlayer({
        position: slot.position,
        servant_id: sid,
        front_factor: 1.0 + frontlineBonus(slot.position, supportInFront),
        personal_bonus: bs.personal_bonus,
        aura_bonus: bs.aura_bonus,
        counted: bs.count_personal_bond,
        counts_max_bond: bs.count_in_team_bonus,
        movable: freePositions.has(slot.position),
        ff_front: ffFront,
        ff_back: ffBack,
        movable_front_slots: movableFrontSlots,
      }),
    );
  }
  return players;
}

export function relaxedSupportCraftScore(
  ctx: DataContext,
  req: CalculationRequest,
  craft: CraftInfo | null | undefined,
  players: RelaxedPlayer[],
): number {
  if (!craft) return 0;
  if (Number(craft.support_bonus || 0) > 0) {
    const weight = relaxedPercentWeight(req);
    const parts: number[] = [];
    for (const p of players) {
      if (p.counted) parts.push(p.front_factor * Number(craft.support_bonus));
    }
    return weight * pySum(parts);
  }
  if (craft.is_bond_ce && Number(craft.support_bonus || 0) <= 0) {
    return relaxedCraftScore(ctx, req, craft, players);
  }
  return 0;
}

export function supportMaxRelaxedAdd(
  ctx: DataContext,
  req: CalculationRequest,
  supportTopOptions: number[],
  supportSecondOptions: number[],
  players: RelaxedPlayer[],
  repeatableIds: Set<number>,
): number {
  const skey = [
    relaxedPercentWeight(req),
    usesPointsScoring(req) ? 1 : 0,
    players
      .map((p) => `${p.servant_id}:${p.position}:${p.front_factor}:${p.counted ? 1 : 0}`)
      .sort()
      .join("|"),
    supportTopOptions.join(","),
    supportSecondOptions.join(","),
  ].join("#");
  const anyCtx = ctx as any;
  if (!anyCtx._supportMaxCache) anyCtx._supportMaxCache = new Map<string, number>();
  const cache: Map<string, number> = anyCtx._supportMaxCache;
  const hit = cache.get(skey);
  if (hit !== undefined) return hit;

  const mainScores: [number, number][] = [];
  for (const cid of supportTopOptions) {
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    mainScores.push([relaxedSupportCraftScore(ctx, req, craft, players), cid]);
  }
  const secondScores: [number, number][] = [];
  for (const cid of supportSecondOptions) {
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    secondScores.push([relaxedSupportCraftScore(ctx, req, craft, players), cid]);
  }
  let best = 0;
  for (const [score] of mainScores) if (score > best) best = score;
  for (const [ms, mid] of mainScores) {
    for (const [ss, sid] of secondScores) {
      if (mid === sid && !repeatableIds.has(mid) && mid > 0) continue;
      const total = ms + ss;
      if (total > best) best = total;
    }
  }
  cache.set(skey, best);
  return best;
}

export type DpCombos = [number, number[]][];

export function prepareDpCraftCombosForTeam(
  ctx: DataContext,
  req: CalculationRequest,
  bp: Blueprint,
  box: Map<number, BoxServant>,
  mapping: Map<string, number>,
  candidateCraftIds: number[],
  costBudget: number,
  zeroCostSlots: boolean[] | null,
  topK = 10,
  cache: Map<string, [RelaxedPlayer[], Map<number, number>, DpCombos]> | null = null,
): [RelaxedPlayer[], Map<number, number>, DpCombos] {
  let key: string | null = null;
  if (cache !== null) {
    key = [
      [...mapping.entries()]
        .map(([pos, sid]) => `${pos}:${sid}`)
        .sort()
        .join("|"),
      costBudget,
      candidateCraftIds.join(","),
      (zeroCostSlots ?? []).map((z) => (z ? 1 : 0)).join(""),
      bp.free_bond_positions.length,
      topK,
    ].join("#");
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const players = relaxedPlayersFromMapping(ctx, req, bp, box, mapping);
  const craftScores = makeCraftScoreMap(ctx, req, players, candidateCraftIds);
  const dpCombos = dpTopCraftCombinations(
    ctx,
    candidateCraftIds,
    bp.free_bond_positions.length,
    costBudget,
    repeatableCraftIds(ctx),
    zeroCostSlots,
    craftScores,
    topK,
  );
  const result: [RelaxedPlayer[], Map<number, number>, DpCombos] = [players, craftScores, dpCombos];
  if (key !== null) cache!.set(key, result);
  return result;
}

export function comboRelaxedScore(combo: number[], craftScores: Map<number, number>): number {
  const parts: number[] = [];
  for (const cid of combo) parts.push(craftScores.get(cid) ?? 0);
  return pySum(parts);
}

/**
 * 便宜礼装项（T1 的核心）：只取"每个空槽能拿到的最好分数"，**完全忽略 Cost 与礼装唯一性**。
 *
 * 口径（可证明是上界）：
 *   · 取所有候选礼装的松弛分，降序；
 *   · 第 i 个槽的上界 = max(第 i 大的礼装分, 可重复礼装里的最大分)；
 *     —— 可重复礼装（通用礼装那类）能占任意多个槽，所以每个槽都能拿到它的分；
 *   · 累加 K 个槽。Cost、槽位限制、非可重复礼装的唯一性一律不管（放松只会高估）。
 *
 * 为什么它一定 ≥ 精确界：任何合法组合里的每张礼装，要么是可重复的（分数 ≤ 可重复最大值），
 * 要么是非可重复的（互不相同 ⇒ 第 i 张 ≤ 第 i 大），逐项对上就压不住。
 */
export function cheapCraftBound(
  ctx: DataContext,
  craftScores: Map<number, number>,
  freeSlots: number,
): number {
  const slots = Math.max(0, Math.trunc(freeSlots));
  if (slots === 0) return 0;
  const repeatableIds = repeatableCraftIds(ctx);
  let repMax = 0;
  const values: number[] = [];
  for (const [cid, v] of craftScores) {
    const val = Number(v) || 0;
    if (val <= 0 && !repeatableIds.has(cid)) continue;
    if (repeatableIds.has(cid) && val > repMax) repMax = val;
    values.push(val);
  }
  values.sort((a, b) => b - a);
  let total = 0;
  for (let i = 0; i < slots; i++) {
    const distinct = i < values.length ? values[i] : 0;
    total += distinct > repMax ? distinct : repMax;
  }
  return total;
}

/**
 * 分数背包上界（T1 正式版）：**遵守 Cost**、允许"最后一件取小数"、可重复礼装不限件数。
 *
 * 为什么不是"取前 K 大"：礼装预算往往只够装 2~3 张（实测一条真实串：5 个槽、预算 40、每张 12），
 * 而"前 K 大"等于当 5 张都装得起 ⇒ 平均松 0.29、最大松 1.47。改成 LP 后平均 0.10、最大 0.53（同批 59,264 套实测）。
 *
 * 仍然是**可证明的上界**：LP 松弛的最优值 ≥ 整数最优（允许取小数只会更高），
 * 而"每件最多 1 次（可重复礼装除外）"与"槽数上限"都保留在可行性里。
 */
export function fractionalCraftBound(
  ctx: DataContext,
  craftScores: Map<number, number>,
  freeSlots: number,
  costBudget: number,
  zeroCostSlots: boolean[] | null = null,
): number {
  const slots = Math.max(0, Math.trunc(freeSlots));
  if (slots === 0) return 0;
  const repeatableIds = repeatableCraftIds(ctx);
  const items: { val: number; cost: number; rep: boolean }[] = [];
  let maxCost = 0;
  for (const [cid, v] of craftScores) {
    const val = Number(v) || 0;
    const cost = Math.max(0, Number(ctx.crafts.get(cid)?.cost ?? 0));
    if (cost > maxCost) maxCost = cost;
    if (val <= 0) continue;
    items.push({ val, cost, rep: repeatableIds.has(cid) });
  }
  // 免费槽（冠位第二礼装位那类 0 Cost 槽）：精确界在那里不花预算 ⇒ 上界也要给它留出容量，
  // 否则会出现"便宜界 < 精确界"的反例（实测踩到：slack 低到 −1.2）。
  const freeSlotCount = Array.isArray(zeroCostSlots) ? zeroCostSlots.filter(Boolean).length : 0;
  // 单价降序（Cost 0 的排最前：不占预算）
  const ratio = (it: { val: number; cost: number }): number => (it.cost === 0 ? Infinity : it.val / it.cost);
  items.sort((a, b) => ratio(b) - ratio(a));
  let cap = Math.max(0, costBudget) + freeSlotCount * maxCost;
  let slotsLeft = slots;
  let total = 0;
  for (const it of items) {
    if (slotsLeft <= 0) break;
    const maxCopies = Math.min(slotsLeft, it.rep ? slotsLeft : 1);
    if (it.cost === 0) {
      total += it.val * maxCopies;
      slotsLeft -= maxCopies;
      continue;
    }
    const affordable = Math.min(maxCopies, Math.floor(cap / it.cost));
    // 这一件能整件取完（含可重复礼装取满剩余槽）：取完继续下一件
    if (affordable === maxCopies) {
      total += it.val * affordable;
      cap -= it.cost * affordable;
      slotsLeft -= affordable;
      continue;
    }
    // 取不完 ⇒ 这是 LP 的"最后一件"：先取能整件取的那几张，再对余额取一次小数，然后收工
    if (affordable > 0) {
      total += it.val * affordable;
      cap -= it.cost * affordable;
      slotsLeft -= affordable;
    }
    if (slotsLeft > 0 && cap > 0 && (it.rep || affordable === 0)) {
      total += it.val * Math.min(1, cap / it.cost);
      slotsLeft -= 1;
      cap = 0;
    }
    break;
  }
  return total;
}

export function relaxedScoreUpperBound(
  ctx: DataContext,
  req: CalculationRequest,
  players: RelaxedPlayer[],
  craftScores: Map<number, number>,
  dpCombos: DpCombos,
  supportTopOptions: number[],
  supportSecondOptions: number[],
  candidateCraftIds: number[] | null = null,
  freeSlotsCount = 0,
  costBudget = 0,
  zeroCostSlots: boolean[] | null = null,
  fixedBondCraftIds: number[] | null = null,
  exactCraftScore: number | null = null,
  /** 用便宜礼装项（T1）代替精确项 —— 只给合法性检查与将来的"两步筛选"用；生产默认 false */
  cheapCraft = false,
): number {
  const repeatableIds = repeatableCraftIds(ctx);
  let baseline = relaxedBaseScore(ctx, req, players);
  for (const cid of fixedBondCraftIds ?? []) {
    baseline += relaxedCraftScore(ctx, req, ctx.crafts.get(cid), players);
  }
  let bestCraftScore: number;
  if (cheapCraft) {
    // 便宜界走"分数背包"（守 Cost、含免费槽容量），而不是"前 K 大"（忽略 Cost）
    bestCraftScore = fractionalCraftBound(ctx, craftScores, freeSlotsCount, costBudget, zeroCostSlots);
  } else if (exactCraftScore !== null) {
    bestCraftScore = exactCraftScore;
  } else {
    const scores: number[] = [];
    for (const [, combo] of dpCombos) scores.push(comboRelaxedScore(combo, craftScores));
    bestCraftScore = scores.length ? Math.max(...scores) : 0;
  }
  const supportAdd = supportMaxRelaxedAdd(
    ctx,
    req,
    supportTopOptions,
    supportSecondOptions,
    players,
    repeatableIds,
  );
  const totalUb = baseline + bestCraftScore + supportAdd;

  if (req.strategy === STRATEGY_TARGET_MAX) {
    const targetPlayers = players.filter((p) => p.servant_id === req.target_servant_id);
    if (targetPlayers.length === 0 || !targetPlayers.some((p) => p.counted)) return totalUb;
    const target = targetPlayers[0];
    let targetInner = 1.0;
    let maxBondCount = 0;
    for (const p of players) if (p.counts_max_bond) maxBondCount += 1;
    targetInner += maxBondCount * 0.25;
    targetInner += req.activity_bonus || 0;
    targetInner += pySum(players.map((p) => Number(p.aura_bonus || 0)));
    targetInner += target.personal_bonus;
    const targetBase =
      relaxedPercentWeight(req) * (target.movable ? target.ff_front : target.front_factor) * targetInner;
    const targetScores = makeCraftScoreMap(ctx, req, targetPlayers, candidateCraftIds ?? []);
    const targetDp = dpTopCraftCombinations(
      ctx,
      candidateCraftIds ?? [],
      freeSlotsCount,
      costBudget,
      repeatableCraftIds(ctx),
      zeroCostSlots,
      targetScores,
      1,
    );
    const targetCraftUb = targetDp.length ? comboRelaxedScore(targetDp[0][1], targetScores) : 0;
    const fixedTargetScore = pySum(
      (fixedBondCraftIds ?? []).map((cid) => relaxedCraftScore(ctx, req, ctx.crafts.get(cid), targetPlayers)),
    );
    const targetUb = targetBase + targetCraftUb + fixedTargetScore + supportAdd;
    return totalUb + targetUb * 10000.0;
  }
  return totalUb;
}

// ---------------------------------------------------------------------------
// 二轮补池（对齐 _collect_used_trait_craft_ids / _expand_reduced_for_trait_synergy）
// ---------------------------------------------------------------------------
interface Entry {
  score: number;
  rank_key: [number, number];
  team: TeamConfig;
  servant_set: number[];
}

export function collectUsedTraitCraftIds(ctx: DataContext, bestBySet: Map<string, Entry>): Set<number> {
  const used = new Set<number>();
  for (const entry of bestBySet.values()) {
    const team = entry.team;
    if (!team) continue;
    for (const p of team.players) {
      for (const cid of [p.craft_id, p.second_craft_id]) {
        if (cid === null || cid === undefined) continue;
        const craft = ctx.crafts.get(cid);
        if (craft && craft.bonus_type === "trait") used.add(cid);
      }
    }
    for (const cid of [team.support_craft_id, team.support_second_craft_id]) {
      if (cid === null || cid === undefined) continue;
      const craft = ctx.crafts.get(cid);
      if (craft && craft.bonus_type === "trait") used.add(cid);
    }
  }
  return used;
}

export function expandReducedForTraitSynergy(
  ctx: DataContext,
  req: CalculationRequest,
  bp: Blueprint,
  box: Map<number, BoxServant>,
  reduced: number[],
  playerCandidates: number[],
  traitIds: number[],
  usedTraitCraftIds: Set<number>,
): number[] {
  if (playerCandidates.length <= reduced.length) return [...reduced];

  const reducedSet = new Set(reduced);
  const additions: number[] = [];

  const fixedMatchingCids = new Set<number>();
  for (const cid of traitIds) {
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    for (const pm of bp.fixed_player_members) {
      if (servantCanMatchCraftAnyStage(ctx, pm.servant_id, craft)) {
        fixedMatchingCids.add(cid);
        break;
      }
    }
  }
  const priorityCids = new Set<number>([...usedTraitCraftIds, ...fixedMatchingCids]);
  const priorityList = [...priorityCids];

  const maxAdd = bp.free_servant_positions.length <= 2 ? 20 : 10;

  // 1) 多触发候选
  const multiSorted = [...playerCandidates].sort((a, b) => {
    const ma = multiTraitCount(ctx, a, traitIds);
    const mb = multiTraitCount(ctx, b, traitIds);
    if (ma !== mb) return mb - ma;
    const ha = servantHeuristic(ctx, box.get(a)!, traitIds);
    const hb = servantHeuristic(ctx, box.get(b)!, traitIds);
    if (ha !== hb) return hb - ha;
    return a - b;
  });
  for (const sid of multiSorted) {
    if (additions.length >= maxAdd) break;
    if (reducedSet.has(sid)) continue;
    if (priorityCids.size > 0) {
      if (!matchesAnyTraitCraft(ctx, sid, priorityList)) continue;
    } else if (multiTraitCount(ctx, sid, traitIds) <= 0) {
      continue;
    }
    additions.push(sid);
    reducedSet.add(sid);
  }

  // 2) 特性组保底 / 固定队协同补人
  const heuristicSorted = [...playerCandidates].sort((a, b) => {
    const ha = servantHeuristic(ctx, box.get(a)!, traitIds);
    const hb = servantHeuristic(ctx, box.get(b)!, traitIds);
    if (ha !== hb) return hb - ha;
    return b - a;
  });
  for (const cid of traitIds) {
    if (additions.length >= maxAdd) break;
    const craft = ctx.crafts.get(cid);
    if (!craft) continue;
    let represented = false;
    for (const sid of reducedSet) {
      if (servantCanMatchCraftAnyStage(ctx, sid, craft)) {
        represented = true;
        break;
      }
    }
    if (represented && !priorityCids.has(cid)) continue;
    for (const sid of heuristicSorted) {
      if (additions.length >= maxAdd) break;
      if (reducedSet.has(sid)) continue;
      if (servantCanMatchCraftAnyStage(ctx, sid, craft)) {
        additions.push(sid);
        reducedSet.add(sid);
        break;
      }
    }
  }

  const additionSet = new Set(additions);
  return [...additions, ...reduced.filter((sid) => !additionSet.has(sid))];
}

// ---------------------------------------------------------------------------
// 同分可替换阵容（对齐 _same_score_team_alternatives 及 alt 系列）
// ---------------------------------------------------------------------------
type Assign = Map<string, [number, number | null, number | null]>;

export function configPartitionKey(assign: Assign): string {
  const front: string[] = [];
  const back: string[] = [];
  for (const [pos, v] of assign) {
    const item = `${v[0]},${v[1] === null ? "" : v[1]},${v[2] === null ? "" : v[2]}`;
    if (FRONT_POSITIONS.has(pos)) front.push(item);
    else back.push(item);
  }
  front.sort();
  back.sort();
  return `${front.join(";")}|${back.join(";")}`;
}

export function sameScoreTeamAlternatives(
  ctx: DataContext,
  box: Map<number, BoxServant>,
  pool: number[],
  fixedIds: Set<number>,
  team: TeamConfig,
  cache: Map<string, [number, number]> | null = null,
  limit = 100,
): [Assign[], number] {
  const players = team.players;
  if (players.length === 0) return [[], 0];
  const crafts: CraftInfo[] = [];
  for (const p of players) {
    for (const cid of [p.craft_id, p.second_craft_id]) {
      if (cid !== null && cid !== undefined && ctx.crafts.has(cid)) crafts.push(ctx.crafts.get(cid)!);
    }
  }
  for (const cid of [team.support_craft_id, team.support_second_craft_id]) {
    if (cid !== null && cid !== undefined && ctx.crafts.has(cid)) crafts.push(ctx.crafts.get(cid)!);
  }
  const store = cache ?? new Map<string, [number, number]>();
  const key = crafts.map((c) => c.id).sort((a, b) => a - b).join(",");

  const effect = (sid: number): [number, number] => {
    const ck = `${key}|${sid}`;
    const hit = store.get(ck);
    if (hit !== undefined) return hit;
    const v = servantCraftEffectMax(ctx, sid, crafts);
    store.set(ck, v);
    return v;
  };

  const meta = (sid: number): any[] => {
    const bs = box.get(sid);
    const info = ctx.servants.get(sid);
    if (!bs || !info) return [null];
    return [
      info.cost,
      pyRound(Number(bs.personal_bonus || 0), 9),
      pyRound(Number(bs.aura_bonus || 0), 9),
      Boolean(bs.count_personal_bond),
      Boolean(bs.count_in_team_bonus),
    ];
  };
  const eqMeta = (a: any[], b: any[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const choices: number[][] = [];
  for (const p of players) {
    const sid = p.servant_id;
    if (fixedIds.has(sid)) {
      choices.push([sid]);
      continue;
    }
    const baseMeta = meta(sid);
    const baseEffect = effect(sid);
    const same = [sid];
    for (const other of pool) {
      if (other === sid || fixedIds.has(other)) continue;
      if (eqMeta(meta(other), baseMeta) && effect(other)[0] === baseEffect[0] && effect(other)[1] === baseEffect[1]) {
        same.push(other);
      }
    }
    choices.push(same);
  }

  const out: Assign[] = [];
  let total = 0;
  const seenTeams = new Set<string>();
  for (const combo of product(choices)) {
    if (new Set(combo).size !== combo.length) continue;
    const assign: Assign = new Map();
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      assign.set(p.position, [combo[i], p.craft_id, p.second_craft_id]);
    }
    const teamKey = configPartitionKey(assign);
    if (seenTeams.has(teamKey)) continue;
    seenTeams.add(teamKey);
    total += 1;
    if (out.length < limit) out.push(assign);
  }
  return [out, total];
}

export function craftMultisetKey(item: any): string {
  const crafts: number[] = [];
  for (const m of item.team ?? []) {
    for (const cid of [m.craftId, m.secondCraftId]) {
      if (cid !== null && cid !== undefined) crafts.push(cid);
    }
  }
  return crafts.sort((a, b) => a - b).join(",");
}

interface AltSlot {
  position: string;
  servantId: number;
  craftId: number | null;
  secondCraftId: number | null;
  changed: boolean;
}

/** 把一条同分阵容排成可直接渲染的顺序（先前排后后排，各段换掉的在前） */
export function orderedAltSlots(
  slotOrder: string[],
  headSidByPos: Map<string, number>,
  entryByPos: Map<string, [number, number | null, number | null]>,
): AltSlot[] {
  const headFront = slotOrder.filter((p) => FRONT_POSITIONS.has(p));
  const headBack = slotOrder.filter((p) => !FRONT_POSITIONS.has(p));
  const headFrontSet = new Set<number>();
  for (const p of headFront) if (headSidByPos.has(p)) headFrontSet.add(headSidByPos.get(p)!);
  const headBackSet = new Set<number>();
  for (const p of headBack) if (headSidByPos.has(p)) headBackSet.add(headSidByPos.get(p)!);

  const seat = (sidePositions: string[], sideHead: Set<number>): AltSlot[] => {
    const pairs: [string, [number, number | null, number | null]][] = [];
    for (const p of sidePositions) {
      const v = entryByPos.get(p);
      if (v !== undefined) pairs.push([p, v]);
    }
    const remaining = [...pairs];
    const seated = new Map<string, [number, number | null, number | null]>();
    for (const pos of sidePositions) {
      const want = headSidByPos.get(pos);
      if (want === undefined) continue;
      const hit = remaining.findIndex(([, v]) => v[0] === want);
      if (hit >= 0) {
        seated.set(pos, remaining[hit][1]);
        remaining.splice(hit, 1);
      }
    }
    for (const pos of sidePositions) {
      if (seated.has(pos)) continue;
      if (remaining.length === 0) break;
      const [entry] = remaining.splice(0, 1);
      seated.set(pos, entry[1]);
    }
    const out: AltSlot[] = [];
    for (const pos of sidePositions) {
      const v = seated.get(pos);
      if (v === undefined) continue;
      out.push({
        position: pos,
        servantId: v[0],
        craftId: v[1],
        secondCraftId: v[2],
        changed: !sideHead.has(v[0]),
      });
    }
    return out;
  };

  const front = seat(headFront, headFrontSet);
  const back = seat(headBack, headBackSet);
  return [
    ...front.filter((x) => x.changed),
    ...front.filter((x) => !x.changed),
    ...back.filter((x) => x.changed),
    ...back.filter((x) => !x.changed),
  ];
}

export function altPayload(
  slotOrder: string[],
  headSidByPos: Map<string, number>,
  entryByPos: Map<string, [number, number | null, number | null]>,
  sup: any,
): any {
  const slots = orderedAltSlots(slotOrder, headSidByPos, entryByPos);
  return {
    positions: slots.map((s) => s.position),
    servantIds: slots.map((s) => s.servantId),
    craftIds: slots.map((s) => s.craftId),
    secondCraftIds: slots.map((s) => s.secondCraftId),
    changed: slots.map((s) => (s.changed ? 1 : 0)),
    supportCraftId: sup ? sup.craftId : null,
    supportSecondCraftId: sup ? sup.secondCraftId : null,
  };
}

/** 下拉里一条同分阵容的规范键：前排成员集合 + 后排成员集合 */
export function entryKey(entry: any, slotOrder: string[] | null = null): string {
  const positions: string[] | undefined = entry.positions;
  const ids: number[] = entry.servantIds ?? [];
  let pairs: [string, number][] = [];
  if (positions && positions.length) {
    pairs = positions.map((pos, i) => [pos, ids[i]] as [string, number]).filter((p) => p[1] !== undefined);
  } else if (slotOrder) {
    pairs = slotOrder.map((pos, i) => [pos, ids[i]] as [string, number]).filter((p) => p[1] !== undefined);
  }
  const front: number[] = [];
  const back: number[] = [];
  for (const [pos, sid] of pairs) {
    if (FRONT_POSITIONS.has(pos)) front.push(sid);
    else back.push(sid);
  }
  front.sort((a, b) => a - b);
  back.sort((a, b) => a - b);
  return `${front.join(",")}|${back.join(",")}`;
}

export function rebaseAlt(alt: any, slotOrder: string[], headSidByPos: Map<string, number>): any {
  const positions: string[] = alt.positions ?? [...slotOrder];
  const ids: number[] = alt.servantIds ?? [];
  const crafts: (number | null)[] = alt.craftIds ?? [];
  const seconds: (number | null)[] = alt.secondCraftIds ?? [];
  const entry = new Map<string, [number, number | null, number | null]>();
  for (let i = 0; i < positions.length; i++) {
    if (i >= ids.length) break;
    entry.set(positions[i], [
      ids[i],
      i < crafts.length ? crafts[i] : null,
      i < seconds.length ? seconds[i] : null,
    ]);
  }
  if (entry.size < slotOrder.length) return alt;
  const sup = { craftId: alt.supportCraftId, secondCraftId: alt.supportSecondCraftId };
  return altPayload(slotOrder, headSidByPos, entry, sup);
}

export function altFromItem(
  item: any,
  slotOrder: string[],
  headSidByPos: Map<string, number> | null = null,
): any {
  const team: any[] = item.team ?? [];
  const byPos = new Map<string, any>();
  for (const m of team) if (!m.isSupport) byPos.set(m.position, m);
  let sup: any = null;
  for (const m of team) if (m.isSupport) sup = m;
  const entry = new Map<string, [number, number | null, number | null]>();
  for (const pos of slotOrder) {
    const m = byPos.get(pos);
    if (!m) return null;
    entry.set(pos, [m.servantId, m.craftId ?? null, m.secondCraftId ?? null]);
  }
  return altPayload(slotOrder, headSidByPos ?? new Map(), entry, sup);
}

export function solutionDict(result: any, rank: number): any {
  return {
    rank,
    totalMultiplier: result.totalMultiplier,
    costUsed: result.costUsed,
    baseBond: result.baseBond ?? 0,
    totalBondPoints: result.totalBondPoints ?? 0,
    team: result.team,
    maxBondStats: result.maxBondStats,
    traitCoverage: result.traitCoverage,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
export async function searchTopTeams(
  ctx: DataContext,
  req: CalculationRequest,
  progress: ((msg: string) => void) | null = null,
  shouldCancel: (() => boolean) | null = null,
  hooks: SearchHooks | null = null,
): Promise<any> {
  const start = nowSec();

  const unavailable = ctx.unavailable_servant_ids ?? new Set<number>();
  if (unavailable.size > 0) {
    const kept = req.box.filter((b) => !unavailable.has(Number(b.servant_id)));
    if (kept.length !== req.box.length) req.box = kept;
  }
  const box = boxMap(req);
  if (req.box.length === 0) throw new Error("请至少勾选一位从者");

  const stopFlag = [false];

  const cancelRequested = (): boolean => {
    if (!shouldCancel) return false;
    try {
      return Boolean(shouldCancel());
    } catch {
      return false;
    }
  };

  const stopped = (): boolean => {
    if (!stopFlag[0] && cancelRequested()) {
      if (superEnabled(req)) stopFlag[0] = true;
      else throw new SearchCancelled("已取消");
    }
    return stopFlag[0];
  };
  const checkCancel = (): void => {
    stopped();
  };
  const expired = (deadline: number): boolean => nowSec() >= deadline || stopped();

  let processedTotal = 0;
  let evaluatedTotal = 0;
  let secondRan = false;
  let secondProcessed = 0;
  let firstProcessed = 0;
  let refineProcessed = 0;
  let optimizeProcessed = 0;
  let truncated = false;
  let globalBestScore: number | null = null;

  // 网页宿主（安卓 Worker）专用：按间隔让出事件循环，好让「停止」消息进来。
  // 桌面 hooks 不传 ⇒ 这两行等于空转，一个时钟都不读。
  const yieldEveryMs = Math.max(0, Number(hooks?.yieldEveryMs ?? 0) || 0);
  let lastYieldAt = start;
  const pump = async (): Promise<void> => {
    if (yieldEveryMs <= 0) return;
    const now = nowSec();
    if (now - lastYieldAt < yieldEveryMs / 1000) return;
    lastYieldAt = now;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // 让出期间宿主可能已经写了取消标志：立刻按同一套语义处理（超级模式收尾 / 普通模式抛出）
    checkCancel();
  };

  const lastTick = [0.0];
  // 结果集要到「生成候选池」之后才建，而 report() 在它之前就会被调用 ⇒ 用一个可后置赋值的取数口，
  // 免得读到 TDZ（超级模式的机读进度行只关心"当前有几支候选"，早于建表的那些行给 0）。
  let bestSize = (): number => 0;
  const report = (msg: string): void => {
    checkCancel();
    if (!progress) return;
    progress(msg);
    // 超级模式：每 2 秒给宿主一行**机读进度**（界面显示"已评 X / 已用 Y 秒"），
    // 与 Python `search.py::report` 的格式**逐字一致**。
    if (superEnabled(req)) {
      const now = nowSec();
      if (now - lastTick[0] >= 2.0) {
        lastTick[0] = now;
        try {
          progress(
            `[super] {"processed": ${processedTotal}, "candidates": ${bestSize()}, "elapsed": ${(now - start).toFixed(1)}}`,
          );
        } catch {
          // 进度回调报错不影响搜索（与 Python 侧一致）
        }
      }
    }
  };

  const bp = prepareBlueprint(req, ctx);
  if (bp.fixed_servant_ids.size > 6) throw new Error("固定从者不能超过6人");

  const chooseCount = bp.free_servant_positions.length;
  const fixedPlayerIds = new Set(bp.fixed_servant_ids);
  const playerCandidates: number[] = [];
  for (const [sid] of box) {
    if (fixedPlayerIds.has(sid)) continue;
    if (req.excluded_servant_ids.has(sid)) continue;
    if (!servantInClassGroup(ctx, sid, req.class_group)) continue;
    playerCandidates.push(sid);
  }

  // Cost 可行性预检
  let fixedCost = 0;
  for (const slot of bp.player_slots) {
    if (slot.fixed_servant_id !== null) {
      const sInfo = ctx.servants.get(slot.fixed_servant_id);
      if (sInfo) fixedCost += sInfo.cost;
    }
    for (const cid of [slot.fixed_craft_id, slot.fixed_second_craft_id]) {
      if (cid === null) continue;
      const cInfo = ctx.crafts.get(cid);
      if (cInfo && cInfo.support_bonus > 0) {
        throw new Error("迦勒底午茶时光等助战加成礼装只能放在助战位");
      }
      if (cid === slot.fixed_craft_id && cInfo) fixedCost += cInfo.cost;
    }
  }
  if (chooseCount > playerCandidates.length) {
    if (unavailable.size > 0) {
      throw new Error(
        `当前服务器（简中服）已排除 ${unavailable.size} 位尚未实装的从者后，` +
          "Box 剩余人数不足，无法组成 5 名玩家 + 助战的队伍",
      );
    }
    throw new Error("Box 人数不足，无法组成 5 名玩家 + 助战的队伍");
  }
  {
    const costs = playerCandidates
      .map((sid) => ctx.servants.get(sid)!.cost)
      .sort((a, b) => a - b)
      .slice(0, chooseCount);
    const minExtraCost = pySum(costs);
    const minTotalCost = fixedCost + minExtraCost;
    if (minTotalCost > req.cost_limit) {
      throw new Error(`当前配置下最小Cost为${minTotalCost}，请提高上限`);
    }
  }

  const traitIds = traitCraftIds(ctx);
  const repeatableIds = repeatableCraftIds(ctx);
  const usedCraftIds = new Set<number>();
  for (const cid of bp.fixed_bond_craft_ids) {
    if (!repeatableIds.has(cid)) usedCraftIds.add(cid);
  }
  const bondCandidates: number[] = [];
  for (const [cid, craft] of ctx.crafts) {
    if (!craft.is_bond_ce) continue;
    if (usedCraftIds.has(cid)) continue;
    if (req.excluded_craft_ids.has(cid)) continue;
    if (isMergedGenericUniversal5(ctx, cid)) continue;
    if (isEventLimitedCraft(ctx, cid)) continue;
    if (isOumaCraft(ctx, cid)) continue;
    if (
      !(
        craft.bonus_value > 0.025 ||
        craft.support_bonus > 0.025 ||
        craft.flat_bonus > 0 ||
        GENERIC_BOND_CRAFT_IDS.has(cid)
      )
    ) {
      continue;
    }
    if (craft.support_bonus > 0) continue;
    bondCandidates.push(cid);
  }
  bondCandidates.sort((a, b) => {
    const ca = ctx.crafts.get(a)!;
    const cb = ctx.crafts.get(b)!;
    if ((ca.bonus_type !== "universal" ? 1 : 0) !== (cb.bonus_type !== "universal" ? 1 : 0)) {
      return (ca.bonus_type !== "universal" ? 1 : 0) - (cb.bonus_type !== "universal" ? 1 : 0);
    }
    if (ca.bonus_value !== cb.bonus_value) return cb.bonus_value - ca.bonus_value;
    if (ca.flat_bonus !== cb.flat_bonus) return cb.flat_bonus - ca.flat_bonus;
    return cb.support_bonus - ca.support_bonus;
  });

  const craftPool = bondCandidates.slice(0, req.craft_pool_size);

  let fixedCraftCost = 0;
  for (const slot of bp.player_slots) {
    if (slot.fixed_craft_id !== null) {
      const c = ctx.crafts.get(slot.fixed_craft_id);
      if (c) fixedCraftCost += c.cost;
    }
  }

  report("正在生成候选池...");
  await pump();
  let reduced = reduceCandidateIds(
    ctx,
    playerCandidates,
    chooseCount,
    defaultServantComboLimit(req, chooseCount),
    box,
    traitIds,
  );
  if (
    req.strategy === STRATEGY_TARGET_MAX &&
    req.target_servant_id !== null &&
    playerCandidates.includes(req.target_servant_id) &&
    !reduced.includes(req.target_servant_id)
  ) {
    reduced.push(req.target_servant_id);
  }

  // 「活动从者优先」保送
  const evFloor = req.event_priority ? EVENT_GUARANTEE_FLOOR_OPTIONAL : EVENT_GUARANTEE_FLOOR_ALWAYS;
  const reducedSet0 = new Set(reduced);
  const evEligible = playerCandidates.filter(
    (sid) => !reducedSet0.has(sid) && Number(box.get(sid)!.personal_bonus || 0) >= evFloor - 1e-9,
  );
  if (evEligible.length > 0) {
    const evShare = traitShareWeight(ctx, playerCandidates, traitIds);
    evEligible.sort((a, b) => {
      const ha = servantHeuristic(ctx, box.get(a)!, traitIds) + clusterBonus(evShare, a);
      const hb = servantHeuristic(ctx, box.get(b)!, traitIds) + clusterBonus(evShare, b);
      return hb - ha;
    });
    reduced.push(...evEligible.slice(0, EVENT_GUARANTEE_CAP));
  }

  // 低 Cost 补位（保证至少一套满自由礼装在 Cost 内可行）
  if (chooseCount > 0 && craftPool.length > 0 && bp.free_bond_positions.length > 0) {
    let maxCraftCost = 0;
    for (const cid of craftPool) {
      const c = ctx.crafts.get(cid)!.cost;
      if (c > maxCraftCost) maxCraftCost = c;
    }
    const maxFreeBondCost = maxCraftCost * bp.free_bond_positions.length;

    const hasFeasibleFullCombo = (pool: number[]): boolean => {
      const costs = pool
        .filter((x) => ctx.servants.has(x))
        .map((x) => ctx.servants.get(x)!.cost)
        .sort((a, b) => a - b)
        .slice(0, chooseCount);
      return (
        costs.length === chooseCount &&
        pySum(costs) + fixedCraftCost + maxFreeBondCost <= req.cost_limit
      );
    };

    if (!hasFeasibleFullCombo(reduced)) {
      const byCost = [...playerCandidates].sort((a, b) => {
        const ca = ctx.servants.has(a) ? ctx.servants.get(a)!.cost : 99;
        const cb = ctx.servants.has(b) ? ctx.servants.get(b)!.cost : 99;
        if (ca !== cb) return ca - cb;
        return a - b;
      });
      for (const sid of byCost) {
        if (reduced.includes(sid)) continue;
        if (reduced.length >= playerCandidates.length) break;
        const trial = [...reduced, sid];
        if (hasFeasibleFullCombo(trial)) {
          reduced.push(sid);
          if (hasFeasibleFullCombo(reduced)) break;
        }
      }
    }
  }

  report("正在搜索组合...");
  const freeSlotsCount = bp.free_bond_positions.length;
  const freeBondZeroCost = bp.player_craft_slots
    .filter((cs) => cs.fixed_craft_id === null)
    .map((cs) => cs.index === 1);
  const craftCombosWithCost = generateCraftCombinationsWithCost(
    ctx,
    craftPool,
    freeSlotsCount,
    defaultCraftComboLimit(req),
    freeBondZeroCost,
  );

  const supportServantId = bp.support_servant_id;
  const supportCraftOpts = supportCraftOptions(ctx, req);
  const supportAutoCraftOpts = autoSupportCraftOptions(ctx, req);
  const supportCrown = bp.crown_positions.has(bp.support_position);
  const supportTopOptions =
    bp.support_craft_id !== null ? [bp.support_craft_id] : [...supportCraftOpts];
  const supportSecondOptions =
    bp.support_second_craft_id !== null
      ? [bp.support_second_craft_id]
      : supportCrown
        ? [...supportAutoCraftOpts]
        : [];

  const bestBySet = new Map<string, Entry>();
  bestSize = () => bestBySet.size;
  const enumTraitCids = new Set<number>();
  const dpCache = new Map<string, [RelaxedPlayer[], Map<number, number>, DpCombos]>();
  const domCache = new Map<string, [Map<number, Set<number>>, Map<number, number>]>();
  const scoreSorted: number[] = [];
  const seen = new Set<string>();
  const noPrune = [false];
  const timeoutSeconds = req.timeout_ms / 1000.0;

  const scoreAdd = (v: number): void => insort(scoreSorted, v);
  const scoreRemove = (v: number): void => removeOne(scoreSorted, v);

  const scoreFromMetrics = (
    metrics: TeamMetrics,
    team: TeamConfig,
    multipliers: number[],
  ): [number, [number, number]] => {
    const flatBonuses = metrics.flatBonuses ?? new Array(multipliers.length).fill(0);
    const totalFlat = metrics.totalFlatBonus ?? 0;
    const totalMult = metrics.totalMultiplier;
    const baseBond = Number(team.base_bond || 0);
    const usePoints = usesPointsScoring(req);
    const pointsValue = totalMult * baseBond + totalFlat;
    const primary = usePoints ? pointsValue : totalMult;
    const secondary = usePoints ? totalMult : pointsValue;
    let score: number;
    if (req.strategy === STRATEGY_TARGET_MAX) {
      const targetId = req.target_servant_id;
      const targetIdx = team.players.findIndex((p) => p.servant_id === targetId);
      let targetValue: number;
      if (targetIdx < 0) targetValue = 0;
      else if (usePoints) targetValue = multipliers[targetIdx] * baseBond + flatBonuses[targetIdx];
      else targetValue = multipliers[targetIdx];
      score = targetValue * 10000 + primary;
    } else if (req.strategy === STRATEGY_BALANCED) {
      const vals = usePoints
        ? multipliers.map((m, i) => m * baseBond + flatBonuses[i])
        : [...multipliers];
      const avg = vals.length ? pySum(vals) / vals.length : 0;
      const variance = vals.length
        ? pySum(vals.map((v) => (v - avg) * (v - avg))) / vals.length
        : 0;
      score = primary * 0.85 - variance * 2.0;
    } else {
      score = primary;
    }
    return [score, [pyRound(score, 9), pyRound(secondary, 9)]];
  };

  const clonePlayer = (p: PlacedMember): PlacedMember =>
    new PlacedMember({
      position: p.position,
      servant_id: p.servant_id,
      stage: p.stage,
      personal_bonus: p.personal_bonus,
      aura_bonus: p.aura_bonus,
      max_bond: p.max_bond,
      bond_switch1: p.bond_switch1,
      bond_switch2: p.bond_switch2,
      craft_id: p.craft_id,
      second_craft_id: p.second_craft_id,
      is_crown: p.is_crown,
      fixed: p.fixed,
      stage_locked: p.stage_locked,
    });

  const cloneTeam = (team: TeamConfig, players: PlacedMember[]): TeamConfig =>
    new TeamConfig({
      players,
      support_position: team.support_position,
      support_servant_id: team.support_servant_id,
      support_craft_id: team.support_craft_id,
      support_second_craft_id: team.support_second_craft_id,
      crown_positions: team.crown_positions,
      base_bond: team.base_bond,
      activity_bonus: team.activity_bonus,
    });

  /** 自由位从者做小规模全排列优化 */
  const optimizeFreePositions = (team: TeamConfig): TeamConfig => {
    const freePositions = [...bp.free_servant_positions].sort(
      (a, b) => POSITIONS.indexOf(a as any) - POSITIONS.indexOf(b as any),
    );
    if (freePositions.length <= 1) return team;
    const byPos = new Map<string, PlacedMember>();
    for (const p of team.players) byPos.set(p.position, p);
    const currentSids: number[] = [];
    for (const pos of freePositions) {
      const p = byPos.get(pos);
      if (!p) return team;
      currentSids.push(p.servant_id);
    }
    if (new Set(currentSids).size !== currentSids.length) return team;
    const freeSet = new Set(freePositions);
    const fixedPlayers = team.players.filter((p) => !freeSet.has(p.position));

    const buildCandidate = (perm: number[]): TeamConfig => {
      const players: PlacedMember[] = [];
      for (const p of fixedPlayers) players.push(clonePlayer(p));
      for (let i = 0; i < freePositions.length; i++) {
        const pos = freePositions[i];
        const sid = perm[i];
        const slot = byPos.get(pos)!;
        const bs = box.get(sid);
        players.push(
          new PlacedMember({
            position: pos,
            servant_id: sid,
            stage: bs ? bs.stage : "fourth",
            personal_bonus: bs ? bs.personal_bonus : 0,
            aura_bonus: bs ? bs.aura_bonus : 0,
            max_bond: bs ? bs.max_bond : false,
            bond_switch1: bs ? bs.bond_switch1 : false,
            bond_switch2: bs ? bs.bond_switch2 : false,
            craft_id: slot.craft_id,
            second_craft_id: slot.second_craft_id,
            is_crown: slot.is_crown,
            fixed: false,
            stage_locked: false,
          }),
        );
      }
      return cloneTeam(team, players);
    };

    let bestTeam = team;
    const initialMetrics = calculateTeamMetrics(ctx, team);
    let bestScore = scoreFromMetrics(initialMetrics, team, initialMetrics.multipliers)[0];
    for (const perm of pyPermutationSetOrder(currentSids)) {
      let candidate = buildCandidate(perm);
      candidate = optimizeTeamStages(ctx, candidate);
      const metrics = calculateTeamMetrics(ctx, candidate);
      const [score] = scoreFromMetrics(metrics, candidate, metrics.multipliers);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestTeam = candidate;
      }
    }
    return bestTeam;
  };

  /** 礼装组合的后置 1-换局部搜索 */
  const craftLocalSearch = (team: TeamConfig): TeamConfig => {
    if (craftPool.length === 0 || team.players.length === 0) return team;
    const freeSlots = bp.player_craft_slots.filter((cs) => cs.fixed_craft_id === null);
    if (freeSlots.length === 0) return team;

    const buildWith = (position: string, index: number, cid: number): TeamConfig => {
      const players: PlacedMember[] = [];
      for (const p of team.players) {
        if (p.position === position) {
          const c = clonePlayer(p);
          if (index === 0) c.craft_id = cid;
          else c.second_craft_id = cid;
          players.push(c);
        } else {
          players.push(clonePlayer(p));
        }
      }
      return cloneTeam(team, players);
    };

    let bestTeam = team;
    const metrics0 = calculateTeamMetrics(ctx, bestTeam);
    let bestScore = scoreFromMetrics(metrics0, bestTeam, metrics0.multipliers)[0];
    for (let round = 0; round < 2; round++) {
      let improved = false;
      for (const cs of freeSlots) {
        const player = bestTeam.players.find((p) => p.position === cs.position);
        if (!player) continue;
        const current = cs.index === 1 ? player.second_craft_id : player.craft_id;
        const used = new Map<number, number>();
        for (const p of bestTeam.players) {
          for (const cid of [p.craft_id, p.second_craft_id]) {
            if (cid !== null && cid !== undefined) used.set(cid, (used.get(cid) ?? 0) + 1);
          }
        }
        const baseCost = teamCost(ctx, bestTeam);
        const oldCost = current !== null && ctx.crafts.has(current) ? ctx.crafts.get(current)!.cost : 0;
        for (const cid of craftPool) {
          if (cid === current) continue;
          const craft = ctx.crafts.get(cid);
          if (!craft || !craft.is_bond_ce) continue;
          if ((used.get(cid) ?? 0) > 0 && !repeatableIds.has(cid)) continue;
          if (cs.index === 0) {
            const newCost = baseCost - oldCost + craft.cost;
            if (newCost > req.cost_limit && newCost > baseCost) continue;
          }
          const candidate = optimizeTeamStages(ctx, buildWith(cs.position, cs.index, cid));
          const m = calculateTeamMetrics(ctx, candidate);
          const [score] = scoreFromMetrics(m, candidate, m.multipliers);
          if (score > bestScore + 1e-9) {
            bestScore = score;
            bestTeam = candidate;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    return bestTeam;
  };

  interface EvalOpts {
    craftCombos?: [number, number[]][] | null;
    useDp?: boolean;
    pairOptimize?: boolean;
    ubOnly?: boolean;
    ubOut?: Map<string, number> | null;
    traitOut?: Set<number> | null;
  }

  const evaluateExtras = (extras: number[], opts: EvalOpts = {}): Entry | undefined => {
    const {
      useDp = false,
      pairOptimize = false,
      ubOnly = false,
      ubOut = null,
      traitOut = null,
    } = opts;
    const originalCraftCombos = opts.craftCombos ?? null;
    let craftCombos: [number, number[]][] | null = originalCraftCombos;
    const usedPlayers = new Set<number>([...bp.fixed_servant_ids, ...extras]);
    if (
      req.strategy === STRATEGY_TARGET_MAX &&
      req.target_servant_id !== null &&
      !usedPlayers.has(req.target_servant_id)
    ) {
      return undefined;
    }
    const servantSetIds = [...usedPlayers].sort((a, b) => a - b);
    const servantSetKey = servantSetIds.join(",");

    let supportId = supportServantId;
    if (supportId === null) {
      supportId = chooseSupport(ctx, req, usedPlayers, box);
      if (supportId === null) {
        return undefined;
      }
    }

    const mapping = greedyMapping(ctx, box, extras, bp.free_servant_positions);

    let servantCost = 0;
    for (const sid of usedPlayers) {
      const s = ctx.servants.get(sid);
      if (s) servantCost += s.cost;
    }
    const ceBudget = req.cost_limit - servantCost - fixedCraftCost;
    if (ceBudget < 0) {
      return undefined;
    }

    const usedList = [...usedPlayers];
    const teamSupportOptions =
      bp.support_craft_id !== null
        ? [...supportTopOptions]
        : filterSupportOptionsForTeam(ctx, supportTopOptions, usedList);
    const teamSupportSecondOptions =
      bp.support_second_craft_id !== null
        ? [...supportSecondOptions]
        : supportSecondOptions.length
          ? filterSupportOptionsForTeam(ctx, supportSecondOptions, usedList)
          : [];

    let dpPlayers: RelaxedPlayer[] | null = null;
    let craftScores: Map<number, number> = new Map();
    let dpCombos: DpCombos = [];
    if (useDp || globalBestScore !== null) {
      const prepared = prepareDpCraftCombosForTeam(
        ctx,
        req,
        bp,
        box,
        mapping,
        craftPool,
        ceBudget,
        freeBondZeroCost,
        12,
        dpCache,
      );
      dpPlayers = prepared[0];
      craftScores = prepared[1];
      dpCombos = prepared[2];
      if (dpPlayers.length > 0) {
        const exact = exactBestCraftScore(
          ctx,
          craftPool,
          freeSlotsCount,
          ceBudget,
          repeatableIds,
          freeBondZeroCost,
          craftScores,
        );
        const ubFn = hooks?.upperBound ?? relaxedScoreUpperBound;
        const ub = ubFn(
          ctx,
          req,
          dpPlayers,
          craftScores,
          dpCombos,
          supportTopOptions,
          supportSecondOptions,
          craftPool,
          freeSlotsCount,
          ceBudget,
          freeBondZeroCost,
          bp.fixed_bond_craft_ids,
          exact,
        );
        if (ubOut !== null) ubOut.set(servantSetKey, ub);
        if (hooks?.onBound) {
          // 同一次调用的便宜界（T1）：只把礼装项换成"Σ 前 K 大"，其余口径一模一样
          const cheap = ubFn(
            ctx,
            req,
            dpPlayers,
            craftScores,
            dpCombos,
            supportTopOptions,
            supportSecondOptions,
            craftPool,
            freeSlotsCount,
            ceBudget,
            freeBondZeroCost,
            bp.fixed_bond_craft_ids,
            exact,
            true,
          );
          hooks.onBound({
            ub,
            cheap,
            craftScores,
            freeSlots: freeSlotsCount,
            costBudget: ceBudget,
            zeroCostSlots: freeBondZeroCost,
          });
        }
        if (traitOut !== null && dpCombos.length > 0) {
          for (const [, combo0] of dpCombos) {
            for (const cid0 of combo0) {
              const cr0 = ctx.crafts.get(cid0);
              if (cr0 && cr0.bonus_type === "trait") traitOut.add(cid0);
            }
          }
        }
        if (ubOnly) {
          return undefined;
        }
        if (bestBySet.size >= req.top_n && !noPrune[0]) {
          const cutoff = scoreSorted[scoreSorted.length - req.top_n];
          if (servantSetIds.includes(605100)) {
          }
          if (ub < cutoff - 1e-9) {
            return undefined;
          }
        }
      }
      if (useDp) {
        if (originalCraftCombos === null) {
          craftCombos = dpCombos;
        } else {
          const seenCombos = new Set(dpCombos.map(([, c]) => c.join(",")));
          const merged: [number, number[]][] = [...dpCombos];
          for (const [cost, combo] of originalCraftCombos) {
            if (!seenCombos.has(combo.join(","))) merged.push([cost, combo]);
          }
          craftCombos = merged;
        }
      }
    }
    if (craftCombos === null) craftCombos = [[0, []]];

    let bestHere: Entry | undefined = bestBySet.get(servantSetKey);
    for (const [craftCost, craftChoice] of craftCombos) {
      if (craftCost > ceBudget) {
        continue;
      }
      let template = makeTeamConfig(
        ctx,
        req,
        bp,
        extras,
        mapping as Map<string, number>,
        craftChoice,
        supportId,
        null,
        null,
      );
      if (template === null) {
        continue;
      }
      if (pairOptimize) {
        const byPos = new Map<string, PlacedMember>();
        for (const p of template.players) byPos.set(p.position, p);
        mergeCraftAssignment(ctx, bp, byPos, craftChoice, 2);
      }
      template = fillRemainingCraftSlots(ctx, req, bp, template, craftPool);
      const playerTpl = template.players.map((p) => ({
        position: p.position,
        servant_id: p.servant_id,
        stage: p.stage,
        personal_bonus: p.personal_bonus,
        max_bond: p.max_bond,
        bond_switch1: p.bond_switch1,
        bond_switch2: p.bond_switch2,
        aura_bonus: p.aura_bonus,
        craft_id: p.craft_id,
        second_craft_id: p.second_craft_id,
        is_crown: p.is_crown,
        fixed: p.fixed,
        stage_locked: p.stage_locked,
      }));
      for (const supportCraftId of teamSupportOptions) {
        const secondIds = teamSupportSecondOptions.length ? teamSupportSecondOptions : [null];
        for (const supportSecondCraftId of secondIds) {
          if (
            supportSecondCraftId !== null &&
            supportCraftId !== null &&
            supportSecondCraftId === supportCraftId &&
            !repeatableIds.has(supportSecondCraftId) &&
            supportSecondCraftId > 0
          ) {
            continue;
          }
          let team = new TeamConfig({
            players: playerTpl.map((t) => new PlacedMember(t as any)),
            support_position: template.support_position,
            support_servant_id: template.support_servant_id,
            support_craft_id: supportCraftId,
            support_second_craft_id: supportSecondCraftId,
            crown_positions: template.crown_positions,
            base_bond: template.base_bond,
            activity_bonus: template.activity_bonus,
          });
          team = optimizeTeamStages(ctx, team);

          const sortedPlayers = [...team.players].sort((a, b) =>
            a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
          );
          const key = JSON.stringify([
            sortedPlayers.map((p) => [p.position, p.servant_id, p.craft_id, p.second_craft_id]),
            [
              team.support_position,
              team.support_servant_id,
              team.support_craft_id,
              team.support_second_craft_id,
            ],
          ]);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          const metrics = calculateTeamMetrics(ctx, team);
          evaluatedTotal += 1;
          const [score, rankKey] = scoreFromMetrics(metrics, team, metrics.multipliers);

          const old = bestBySet.get(servantSetKey);
          if (old === undefined || rankKeyGreater(rankKey, old.rank_key)) {
            if (old !== undefined) scoreRemove(old.score);
            scoreAdd(score);
            const entry: Entry = {
              score,
              rank_key: rankKey,
              team,
              servant_set: servantSetIds,
            };
            bestBySet.set(servantSetKey, entry);
            bestHere = entry;
            if (globalBestScore === null || score > globalBestScore) globalBestScore = score;
          }
        }
      }
    }
    return bestHere;
  };

  const runWithCraftCombos = async (
    candidateIds: number[],
    deadline: number,
    craftCombos: [number, number[]][] | null,
    servantLimit: number | null = null,
    useDp = false,
    maxProcessed: number | null = null,
  ): Promise<void> => {
    let processed = 0;
    const domKey = candidateIds.join(",");
    let prep = domCache.get(domKey);
    if (prep === undefined) {
      const dom = dominanceMap(ctx, box, candidateIds, traitIds);
      prep = dom.size ? [dom, canonicalMap(candidateIds, dom)] : [new Map(), new Map()];
      domCache.set(domKey, prep);
    }
    const [dom, canon] = prep;

    const combosIter: number[][] =
      servantLimit !== null
        ? sampleServantCombinations(
            candidateIds,
            chooseCount,
            servantLimit,
            ctx,
            traitIds,
            Math.max(1, bp.free_bond_positions.length || bp.player_craft_slots.length),
            candidateIds.length > chooseCount * 3,
            dom,
            canon,
          )
        : generateServantCombinations(candidateIds, chooseCount);

    const pending: [number, number[]][] = [];
    for (const extrasTuple of combosIter) {
      if (maxProcessed !== null && processed >= maxProcessed) break;
      await pump();
      if (expired(deadline)) {
        truncated = true;
        report("达到时间预算，提前结束当前轮搜索");
        break;
      }
      const usedPlayers = new Set<number>([...bp.fixed_servant_ids, ...extrasTuple]);
      const servantSetIds = [...usedPlayers].sort((a, b) => a - b);
      const servantKey = servantSetIds.join(",");
      if (bestBySet.has(servantKey)) {
        processed += 1;
        processedTotal += 1;
        continue;
      }
      const ubBox = new Map<string, number>();
      evaluateExtras(extrasTuple, {
        craftCombos,
        useDp,
        ubOnly: true,
        ubOut: ubBox,
        traitOut: enumTraitCids,
      });
      const ub = ubBox.has(servantKey) ? ubBox.get(servantKey)! : Infinity;
      pending.push([ub, extrasTuple]);
      processed += 1;
      processedTotal += 1;
      if (processed % 10 === 0 || processed === 1) {
        checkCancel();
        if (progress && (processed % 100 === 0 || processed === 1)) {
          const elapsed = nowSec() - start;
          report(
            `已评估 ${evaluatedTotal.toLocaleString("en-US")} 个队伍配置` +
              `（时间预算 ${Math.trunc(timeoutSeconds)}s，当前 ${elapsed.toFixed(1)}s）`,
          );
        }
      }
    }

    pending.sort((a, b) => b[0] - a[0]);
    for (const [ub, extrasTuple] of pending) {
      await pump();
      if (expired(deadline)) {
        truncated = true;
        break;
      }
      checkCancel();
      if (bestBySet.size >= req.top_n && !noPrune[0]) {
        const cutoff = scoreSorted[scoreSorted.length - req.top_n];
        if (ub < cutoff - 1e-9) break;
      }
      evaluateExtras(extrasTuple, { craftCombos, useDp });
    }
  };

  // 复现模式：固定工作量
  let phaseLimits: Record<string, any> | null = req.verify_phase_limits ?? null;
  if (!(phaseLimits && typeof phaseLimits === "object" && "firstProcessed" in phaseLimits)) {
    phaseLimits = null;
  }

  const fullCombos: [number, number[]][] = [...craftCombosWithCost];
  // 内存安全阀：网页宿主（安卓 WebView Worker）的堆抬不上去，极端形状会把 worker 打崩。
  // 超上限就裁剪本轮枚举量，并在结果里标 `workCapped`、进度里说清楚——宁可少搜一点也不要崩。
  const rawSweepLimit = defaultSweepLimit(req);
  const platformCap = getPlatform().maxWorkPerRound;
  const workCap = Number.isFinite(platformCap) && Number(platformCap) > 0 ? Number(platformCap) : Infinity;
  const servantSweepLimit = Math.min(rawSweepLimit, workCap);
  const workCapped = servantSweepLimit < rawSweepLimit;
  if (workCapped) {
    report(
      `本次搜索规模按设备内存上限裁剪（每轮最多 ${servantSweepLimit.toLocaleString("en-US")} 个阵容；` +
        `可把「结果条数」或超级档位调小以恢复完整搜索）`,
    );
  }

  // 第一轮：静态分候选池，等距抽样建 Top 基线
  const firstDeadline = start + Math.min(timeoutSeconds, Math.max(5.0, timeoutSeconds * 0.5));
  const firstLimit = phaseLimits ? Math.trunc(phaseLimits.firstProcessed ?? 0) : servantSweepLimit;
  const beforeFirst = processedTotal;
  await runWithCraftCombos(reduced, firstDeadline, null, servantSweepLimit, true, firstLimit);
  firstProcessed = processedTotal - beforeFirst;

  // 第二轮：补人后再粗搜
  let secondPoolIds: number[] = [];
  const shouldRunSecond = phaseLimits
    ? Boolean(phaseLimits.secondRan)
    : bestBySet.size > 0 && !truncated;
  if (shouldRunSecond) {
    const usedTraitCraftIds = new Set<number>([
      ...collectUsedTraitCraftIds(ctx, bestBySet),
      ...enumTraitCids,
    ]);
    const expanded = expandReducedForTraitSynergy(
      ctx,
      req,
      bp,
      box,
      reduced,
      playerCandidates,
      traitIds,
      usedTraitCraftIds,
    );
    if (expanded.length > reduced.length) {
      const added = expanded.length - reduced.length;
      report(`第二轮补入 ${added} 名协同候选，继续搜索...`);
      const secondDeadline = start + Math.min(timeoutSeconds, Math.max(5.0, timeoutSeconds * 0.75));
      const secondLimit = phaseLimits ? Math.trunc(phaseLimits.secondProcessed ?? 0) : servantSweepLimit;
      const beforeSecond = processedTotal;
      await runWithCraftCombos(expanded, secondDeadline, null, servantSweepLimit, true, secondLimit);
      secondProcessed = processedTotal - beforeSecond;
      secondRan = true;
      secondPoolIds = [...expanded];
    }
  }

  // ① 礼装集合优先
  if ((req.search_order ?? "servant") === "craft" && craftPool.length > 0 && nowSec() < start + timeoutSeconds) {
    const table = traitBenefitTable(ctx);
    const posTrait = craftPool.filter((cid) => traitIds.includes(cid) && table.craftValue(cid) > 0);
    const l1Dropped = posTrait.filter((cid) =>
      playerCandidates.every((sid) => table.canTrigger(sid, cid)),
    );
    const traitPool = posTrait.filter((cid) => !l1Dropped.includes(cid));
    const slots = Math.min(bp.free_bond_positions.length || bp.player_craft_slots.length, 5);
    const needPlayers = bp.free_servant_positions.length;
    const craftFirstDeadline = start + timeoutSeconds * 0.85;
    const lineupBudget = defaultCraftSetLineupBudget(req);
    if (traitPool.length > 0 && needPlayers > 0) {
      const sets: [number, number[], number[]][] = [];
      let built = 0;
      let abortBuild = false;
      for (let n = 1; n <= slots; n++) {
        for (const combo of combinations(traitPool, n)) {
          built += 1;
          if (built % 200 === 0 && expired(craftFirstDeadline)) {
            abortBuild = true;
            break;
          }
          const members = playerCandidates.filter((sid) =>
            combo.some((cid) => table.canTrigger(sid, cid)),
          );
          if (members.length < needPlayers) continue;
          const hitCount = new Map<number, number>();
          for (const s of members) {
            let c = 0;
            for (const cid of combo) if (table.canTrigger(s, cid)) c += 1;
            hitCount.set(s, c);
          }
          members.sort((a, b) => {
            const ha = hitCount.get(a)!;
            const hb = hitCount.get(b)!;
            if (ha !== hb) return hb - ha;
            const sa = servantHeuristic(ctx, box.get(a)!, traitIds);
            const sb = servantHeuristic(ctx, box.get(b)!, traitIds);
            if (sa !== sb) return sb - sa;
            return 0;
          });
          const valueParts: number[] = [];
          for (const cid of combo) {
            valueParts.push(table.craftValue(cid) * members.filter((s) => table.canTrigger(s, cid)).length);
          }
          sets.push([pySum(valueParts), combo, members]);
        }
        if (abortBuild) break;
      }
      sets.sort((a, b) => b[0] - a[0]);

      const domPc = dominanceMap(ctx, box, playerCandidates, traitIds);
      const canonPc = domPc.size ? canonicalMap(playerCandidates, domPc) : new Map<number, number>();
      const pcSeen = new Set<string>();
      let passLineups = 0;
      noPrune[0] = true;
      const tripTouched: number[][] = [];
      for (let si = 0; si < sets.length; si++) {
        const [, combo, members] = sets[si];
        await pump();
        checkCancel();
        if (passLineups >= lineupBudget) break;
        if (expired(craftFirstDeadline)) break;
        const pinCost = craftComboActualCost(ctx, combo, freeBondZeroCost);
        const pinned: [number, number[]][] = [[pinCost, combo]];
        const half = Math.trunc((members.length + 1) / 2);
        const scan: number[] = [];
        for (let i = 0; i < members.length; i++) {
          scan.push(members[Math.trunc(i / 2) + (i % 2 === 0 ? 0 : half)]);
        }
        const totalCombos = comb(scan.length, needPlayers);
        const quota = Math.min(
          totalCombos,
          Math.max(4, Math.trunc((lineupBudget - passLineups) / Math.max(1, sets.length - si))),
        );
        let tried = 0;
        let depth = needPlayers - 1;
        while (tried < quota && depth < scan.length) {
          for (const head of combinations(scan.slice(0, depth), needPlayers - 1)) {
            if (tried >= quota || passLineups >= lineupBudget) break;
            await pump();
            let lineup = [...head, scan[depth]].sort((a, b) => a - b);
            lineup = canonicalCombo(lineup, domPc, canonPc);
            const lineKey = lineup.join(",");
            if (pcSeen.has(lineKey)) continue;
            pcSeen.add(lineKey);
            const extrasTuple = sortedUniqueNums(lineup.filter((sid) => !bp.fixed_servant_ids.has(sid)));
            if (extrasTuple.length === 0) continue;
            passLineups += 1;
            tried += 1;
            evaluateExtras(extrasTuple, { craftCombos: pinned });
            tripTouched.push(extrasTuple);
          }
          depth += 1;
        }
      }
      noPrune[0] = false;

      if (tripTouched.length > 0) {
        const recheckCount = defaultTripRecheckCount(req);
        const touchedScored: [[number, number], number[]][] = [];
        const seenExtras = new Set<string>();
        for (const ex of tripTouched) {
          const exKey = ex.join(",");
          if (seenExtras.has(exKey)) continue;
          seenExtras.add(exKey);
          const key = sortedKey([...ex, ...bp.fixed_servant_ids]);
          const ent = bestBySet.get(key);
          if (ent !== undefined) touchedScored.push([ent.rank_key, ex]);
        }
        touchedScored.sort((a, b) => (rankKeyGreater(a[0], b[0]) ? -1 : rankKeyGreater(b[0], a[0]) ? 1 : 0));
        const tripDeadline = start + timeoutSeconds * 0.95;
        for (const [, ex] of touchedScored.slice(0, recheckCount)) {
          if (expired(tripDeadline)) {
            truncated = true;
            break;
          }
          evaluateExtras(ex, { useDp: true });
        }
      }
    }
  }

  // 精算
  const refineCount = defaultRefineCount(req, bestBySet.size);
  const refineEntries = [...bestBySet.values()]
    .sort((a, b) =>
      rankKeyGreater(a.rank_key, b.rank_key) ? -1 : rankKeyGreater(b.rank_key, a.rank_key) ? 1 : 0,
    )
    .slice(0, refineCount);
  const refineDeadline = start + timeoutSeconds;
  const refinedEntries: Entry[] = [];
  for (const entry of refineEntries) {
    await pump();
    checkCancel();
    if (phaseLimits) {
      if (refineProcessed >= Math.trunc(phaseLimits.refineProcessed ?? 0)) break;
    }
    if (expired(refineDeadline)) {
      truncated = true;
      break;
    }
    refineProcessed += 1;
    refinedEntries.push(entry);
    const servantSet = entry.servant_set;
    if (!servantSet.length) continue;
    const extrasTuple = sortedUniqueNums(servantSet.filter((sid) => !bp.fixed_servant_ids.has(sid)));
    evaluateExtras(extrasTuple, { craftCombos: fullCombos, pairOptimize: true });
  }

  // 精算后自由位排列优化
  if (optimizeFreePositionsEnabled()) {
    for (const entry of refineEntries) {
      await pump();
      if (phaseLimits) {
        if (optimizeProcessed >= Math.trunc(phaseLimits.optimizeProcessed ?? 0)) break;
      }
      if (expired(refineDeadline)) {
        truncated = true;
        break;
      }
      optimizeProcessed += 1;
      const servantSet = entry.servant_set;
      if (!servantSet.length) continue;
      const key = servantSet.join(",");
      const current = bestBySet.get(key);
      if (!current) continue;
      const optimized = optimizeFreePositions(current.team);
      const metrics = calculateTeamMetrics(ctx, optimized);
      const [score, rankKey] = scoreFromMetrics(metrics, optimized, metrics.multipliers);
      if (rankKeyGreater(rankKey, current.rank_key)) {
        scoreRemove(current.score);
        scoreAdd(score);
        current.team = optimized;
        current.score = score;
        current.rank_key = rankKey;
        if (globalBestScore === null || score > globalBestScore) globalBestScore = score;
      }
    }
  }

  // 邻域换人
  const neighborhood = (String(req.neighborhood || "standard") || "standard").toLowerCase();
  const neighborhoodRounds = neighborhood === "off" ? 0 : neighborhood === "deep" ? 3 : 2;
  const nbRefineCount = defaultNeighborRefineCount(req);
  const nbPool: number[][] = [];
  if (neighborhoodRounds > 0 && bp.free_servant_positions.length > 0 && nowSec() < refineDeadline) {
    const poolSet = new Set(reduced);
    const outside = [...playerCandidates]
      .filter((sid) => !poolSet.has(sid))
      .sort((a, b) => {
        const ha = servantHeuristic(ctx, box.get(a)!, traitIds);
        const hb = servantHeuristic(ctx, box.get(b)!, traitIds);
        return hb - ha;
      })
      .slice(0, 30);
    const neighborIds: number[] = [];
    const pushUnique = (sid: number): void => {
      if (!neighborIds.includes(sid)) neighborIds.push(sid);
    };
    for (const sid of reduced) pushUnique(sid);
    for (const sid of outside) pushUnique(sid);

    const poolTruncated = reduced.length < playerCandidates.length;
    const usedTraitCids = poolTruncated ? collectUsedTraitCraftIds(ctx, bestBySet) : new Set<number>();
    let synergyIds: number[] = [];
    if (usedTraitCids.size > 0) {
      const table = traitBenefitTable(ctx);
      const known = new Set(neighborIds);
      const synergy: [number, number, number][] = [];
      for (const sid of playerCandidates) {
        if (known.has(sid)) continue;
        let hits = 0;
        for (const cid of usedTraitCids) if (table.canTrigger(sid, cid)) hits += 1;
        if (hits) synergy.push([hits, servantHeuristic(ctx, box.get(sid)!, traitIds), sid]);
      }
      synergy.sort((a, b) => {
        if (a[0] !== b[0]) return b[0] - a[0];
        if (a[1] !== b[1]) return b[1] - a[1];
        return b[2] - a[2];
      });
      synergyIds = synergy.slice(0, 60).map((x) => x[2]);
      for (const sid of synergyIds) neighborIds.push(sid);
    }

    const freeCount = bp.free_servant_positions.length;
    for (let round = 0; round < neighborhoodRounds; round++) {
      const seeds = [...bestBySet.values()]
        .sort((a, b) =>
          rankKeyGreater(a.rank_key, b.rank_key) ? -1 : rankKeyGreater(b.rank_key, a.rank_key) ? 1 : 0,
        )
        .slice(0, 20)
        .filter((e) => e.servant_set.length > 0);
      if (seeds.length === 0) break;

      // 协同换人（换人后重新配一次礼装再判定）
      if (synergyIds.length > 0) {
        let synBudget = 60;
        const synSeen = new Set<string>();
        for (const sid of synergyIds) {
          if (synBudget <= 0) break;
          for (const a of seeds.slice(0, 4)) {
            if (synBudget <= 0) break;
            const aIds = [...a.servant_set];
            const freePart = aIds.filter((x) => !bp.fixed_servant_ids.has(x));
            if (freePart.length !== freeCount || aIds.includes(sid)) continue;
            for (let i = 0; i < aIds.length; i++) {
              if (synBudget <= 0) break;
              const nxt = [...aIds];
              nxt[i] = sid;
              const key = sortedKey(nxt);
              if (synSeen.has(key)) continue;
              synSeen.add(key);
              checkCancel();
              if (expired(refineDeadline)) {
                truncated = true;
                synBudget = 0;
                break;
              }
              const extras = sortedUniqueNums(nxt.filter((x) => !bp.fixed_servant_ids.has(x)));
              if (extras.length === 0) continue;
              synBudget -= 1;
              evaluateExtras(extras, { useDp: true, pairOptimize: true });
            }
          }
        }
      }

      const swaps = new Map<string, number[]>();
      // ⚠️ 存**排好序**的版本：Python 的 swaps key 就是 tuple(sorted(nxt))，
      // 后面 _canonical_combo 直接吃它；顺序不同会规范化到不同代表。
      const addSwap = (nxt: number[]): void => {
        const k = sortedKey(nxt);
        if (!bestBySet.has(k)) swaps.set(k, [...nxt].sort((a, b) => a - b));
      };
      for (let i = 0; i < seeds.length; i++) {
        const a = seeds[i];
        const aIds = a.servant_set;
        if (aIds.filter((x) => !bp.fixed_servant_ids.has(x)).length !== freeCount) continue;
        for (const b of seeds.slice(i + 1)) {
          const bIds = b.servant_set;
          if (bIds.length !== freeCount) continue;
          const bSet = new Set(bIds);
          for (let posIdx = 0; posIdx < aIds.length; posIdx++) {
            if (bSet.has(aIds[posIdx])) continue;
            const nxt = [...aIds];
            nxt[posIdx] = bIds[posIdx];
            const key = sortedKey(nxt);
            if (!bestBySet.has(key)) addSwap(nxt);
          }
        }
      }
      // 单点替换
      for (const a of seeds) {
        const aIds = a.servant_set;
        if (aIds.filter((x) => !bp.fixed_servant_ids.has(x)).length !== freeCount) continue;
        for (let posIdx = 0; posIdx < aIds.length; posIdx++) {
          for (const sid of neighborIds) {
            if (aIds.includes(sid)) continue;
            const nxt = [...aIds];
            nxt[posIdx] = sid;
            const key = sortedKey(nxt);
            if (!bestBySet.has(key)) addSwap(nxt);
          }
        }
      }
      // 2-换
      if (round >= 1) {
        const topSeeds = seeds.slice(0, 2);
        const candSrc = neighborIds.slice(0, 8);
        for (const a of topSeeds) {
          const aIds = a.servant_set;
          if (aIds.filter((x) => !bp.fixed_servant_ids.has(x)).length !== freeCount) continue;
          for (let i = 0; i < aIds.length; i++) {
            for (let j = i + 1; j < aIds.length; j++) {
              for (const s1 of candSrc) {
                if (aIds.includes(s1)) continue;
                for (const s2 of candSrc) {
                  if (aIds.includes(s2) || s2 === s1) continue;
                  const nxt = [...aIds];
                  nxt[i] = s1;
                  nxt[j] = s2;
                  const key = sortedKey(nxt);
                  if (!bestBySet.has(key)) addSwap(nxt);
                }
              }
            }
          }
        }
      }
      // 3-换（仅 deep）
      if (
        neighborhood === "deep" &&
        round >= 2 &&
        seeds.length > 0 &&
        bp.free_servant_positions.length > 0 &&
        nowSec() < refineDeadline - 5.0
      ) {
        const a = seeds[0];
        const aIds = a.servant_set;
        if (aIds.filter((x) => !bp.fixed_servant_ids.has(x)).length === freeCount) {
          const tail = neighborIds.slice(4, 24).filter((s) => !aIds.includes(s));
          const candSrc = tail.slice(0, 6);
          const positions = aIds.map((_, idx) => idx);
          // break 结构与 Python 一致：两层 `if len(swaps) >= 400: break`
          // 分别收掉 s2 / s1 循环；(i,j,k) 外层**继续**跑。
          for (const i of positions) {
            for (const j of positions) {
              if (j <= i) continue;
              for (const k of positions) {
                if (k <= j) continue;
                for (const s1 of candSrc) {
                  for (const s2 of candSrc) {
                    if (s2 === s1) continue;
                    for (const s3 of candSrc) {
                      if (s3 === s1 || s3 === s2) continue;
                      const nxt = [...aIds];
                      nxt[i] = s1;
                      nxt[j] = s2;
                      nxt[k] = s3;
                      const key = sortedKey(nxt);
                      if (!bestBySet.has(key)) addSwap(nxt);
                    }
                    if (swaps.size >= 400) break;
                  }
                  if (swaps.size >= 400) break;
                }
              }
            }
          }
        }
      }
      if (swaps.size === 0) break;

      const nbDom = dominanceMap(ctx, box, neighborIds, traitIds);
      const nbCanon = nbDom.size ? canonicalMap(neighborIds, nbDom) : new Map<number, number>();
      const nbSeen = new Set<string>();
      for (const rawKey of [...swaps.values()]) {
        await pump();
        checkCancel();
        if (expired(refineDeadline)) {
          truncated = true;
          break;
        }
        const raw605 = rawKey.includes(605100);
        const key = canonicalCombo(rawKey, nbDom, nbCanon);
        const keyStr = sortedKey(key);
        if (raw605 || key.includes(605100)) {
        }
        if (bestBySet.has(keyStr) || nbSeen.has(keyStr)) continue;
        nbSeen.add(keyStr);
        const extrasTuple = sortedUniqueNums(key.filter((x) => !bp.fixed_servant_ids.has(x)));
        if (extrasTuple.length === 0) continue;
        evaluateExtras(extrasTuple, { useDp: true });
        nbPool.push(extrasTuple);
      }
    }
  }

  // 邻域候选的昂贵口径复核（放在所有搜索趟之后）
  if (nbPool.length > 0 && nbRefineCount > 0) {
    const nbScored: [[number, number], number[]][] = [];
    for (const nbExtras of nbPool) {
      const ent = bestBySet.get(sortedKey([...bp.fixed_servant_ids, ...nbExtras]));
      if (ent !== undefined) nbScored.push([ent.rank_key, nbExtras]);
    }
    nbScored.sort((a, b) => (rankKeyGreater(a[0], b[0]) ? -1 : rankKeyGreater(b[0], a[0]) ? 1 : 0));
    for (const [, nbExtras] of nbScored.slice(0, nbRefineCount)) {
      await pump();
      if (expired(refineDeadline)) {
        truncated = true;
        break;
      }
      evaluateExtras(nbExtras, { craftCombos: fullCombos, pairOptimize: true });
    }
  }

  // 礼装层后置 1-换局部搜索
  for (const entry of refinedEntries) {
    if (expired(refineDeadline)) {
      truncated = true;
      break;
    }
    const servantSet = entry.servant_set;
    if (!servantSet.length) continue;
    const key = servantSet.join(",");
    const current = bestBySet.get(key);
    if (!current) continue;
    let upgraded = craftLocalSearch(current.team);
    if (upgraded === current.team) continue;
    if (optimizeFreePositionsEnabled()) upgraded = optimizeFreePositions(upgraded);
    const metrics = calculateTeamMetrics(ctx, upgraded);
    const [score, rankKey] = scoreFromMetrics(metrics, upgraded, metrics.multipliers);
    if (rankKeyGreater(rankKey, current.rank_key)) {
      scoreRemove(current.score);
      scoreAdd(score);
      current.team = upgraded;
      current.score = score;
      current.rank_key = rankKey;
      if (globalBestScore === null || score > globalBestScore) globalBestScore = score;
    }
  }

  report("排序输出...");
  let bestItems = [...bestBySet.values()]
    .sort((a, b) =>
      rankKeyGreater(a.rank_key, b.rank_key) ? -1 : rankKeyGreater(b.rank_key, a.rank_key) ? 1 : 0,
    )
    .slice(0, req.top_n);

  /** 按"与站位无关的那部分加成"排序，把强的排进前排自由位 */
  const rearrangeByBonus = (team: TeamConfig): TeamConfig => {
    const freePositions = [...bp.free_servant_positions].sort(
      (a, b) => POSITIONS.indexOf(a as any) - POSITIONS.indexOf(b as any),
    );
    if (freePositions.length <= 1) return team;
    const byPos = new Map<string, PlacedMember>();
    for (const p of team.players) byPos.set(p.position, p);
    for (const pos of freePositions) if (!byPos.has(pos)) return team;
    const metrics = calculateTeamMetrics(ctx, team);
    const mults = metrics.multipliers ?? [];
    if (mults.length !== team.players.length) return team;
    const supportInFront = team.support_position !== null && FRONT_POSITIONS.has(team.support_position);
    const freeSet = new Set(freePositions);
    const key = new Map<string, number>();
    for (let i = 0; i < team.players.length; i++) {
      const player = team.players[i];
      if (!freeSet.has(player.position)) continue;
      const front = frontlineBonus(player.position, supportInFront);
      key.set(player.position, 1.0 + front ? mults[i] / (1.0 + front) : 0);
    }
    if (key.size !== freePositions.length) return team;
    const ranked = [...freePositions].sort((a, b) => key.get(b)! - key.get(a)!);
    const target = [
      ...freePositions.filter((pos) => FRONT_POSITIONS.has(pos)),
      ...freePositions.filter((pos) => !FRONT_POSITIONS.has(pos)),
    ];
    const assigned = new Map<string, number>();
    for (let i = 0; i < freePositions.length; i++) assigned.set(target[i], byPos.get(ranked[i])!.servant_id);
    let same = true;
    for (const pos of freePositions) {
      if (assigned.get(pos) !== byPos.get(pos)!.servant_id) {
        same = false;
        break;
      }
    }
    if (same) return team;
    const players: PlacedMember[] = [];
    for (const player of team.players) {
      if (!assigned.has(player.position)) {
        players.push(player);
        continue;
      }
      const slot = byPos.get(player.position)!;
      const sid = assigned.get(player.position)!;
      const bs = box.get(sid);
      players.push(
        new PlacedMember({
          position: player.position,
          servant_id: sid,
          stage: bs ? bs.stage : player.stage,
          personal_bonus: bs ? bs.personal_bonus : player.personal_bonus,
          aura_bonus: bs ? bs.aura_bonus : player.aura_bonus,
          max_bond: bs ? bs.max_bond : player.max_bond,
          bond_switch1: bs ? bs.bond_switch1 : player.bond_switch1,
          bond_switch2: bs ? bs.bond_switch2 : player.bond_switch2,
          craft_id: slot.craft_id,
          second_craft_id: slot.second_craft_id,
          is_crown: slot.is_crown,
          fixed: false,
          stage_locked: false,
        }),
      );
    }
    const candidate = cloneTeam(team, players);
    return optimizeTeamStages(ctx, candidate);
  };

  if (optimizeFreePositionsEnabled()) {
    let posfixFixed = 0;
    const posfixStart = nowSec();
    for (const entry of [...bestItems]) {
      await pump();
      const current = entry.team;
      const candidate = rearrangeByBonus(current);
      if (candidate === current) continue;
      const metrics = calculateTeamMetrics(ctx, candidate);
      const [score, rankKey] = scoreFromMetrics(metrics, candidate, metrics.multipliers);
      if (rankKeyGreater(rankKey, entry.rank_key)) {
        entry.team = candidate;
        entry.score = score;
        entry.rank_key = rankKey;
        posfixFixed += 1;
      }
    }
    if (posfixFixed) {
      bestItems.sort((a, b) =>
        rankKeyGreater(a.rank_key, b.rank_key) ? -1 : rankKeyGreater(b.rank_key, a.rank_key) ? 1 : 0,
      );
    }
    for (const entry of bestItems.slice(0, POSFIX_ENUM_ROWS)) {
      const current = entry.team;
      const optimized = optimizeFreePositions(current);
      if (optimized === current) continue;
      const metrics = calculateTeamMetrics(ctx, optimized);
      const [score, rankKey] = scoreFromMetrics(metrics, optimized, metrics.multipliers);
      if (rankKeyGreater(rankKey, entry.rank_key)) {
        entry.team = optimized;
        entry.score = score;
        entry.rank_key = rankKey;
        posfixFixed += 1;
      }
    }
    if (posfixFixed) {
      bestItems.sort((a, b) =>
        rankKeyGreater(a.rank_key, b.rank_key) ? -1 : rankKeyGreater(b.rank_key, a.rank_key) ? 1 : 0,
      );
    }
    report(`站位复核：${posfixFixed} 行改好了（${(nowSec() - posfixStart).toFixed(2)}s）`);
  }

  // 同分可替换阵容
  const altsCache = new Map<string, [number, number]>();
  const altsPool = sortedUniqueNums([...reduced, ...secondPoolIds]);
  let poolCombos = 0;
  if (chooseCount > 0) {
    try {
      poolCombos = comb(altsPool.length, chooseCount);
    } catch {
      poolCombos = 0;
    }
  }

  const top: any[] = [];
  for (let i = 0; i < bestItems.length; i++) {
    const entry = bestItems[i];
    await pump();
    const result = evaluateTeam(ctx, entry.team);
    const item = solutionDict(result, i + 1);
    const [groups, total] = sameScoreTeamAlternatives(
      ctx,
      box,
      altsPool,
      bp.fixed_servant_ids,
      entry.team,
      altsCache,
    );
    const slotOrder: string[] = item.team.filter((m: any) => !m.isSupport).map((m: any) => m.position);
    const headSidByPos = new Map<string, number>();
    for (const m of item.team) if (!m.isSupport) headSidByPos.set(m.position, m.servantId);
    let sup: any = null;
    for (const m of item.team) if (m.isSupport) sup = m;
    item.sameScoreTeams = groups
      .filter((g) => slotOrder.every((pos) => g.has(pos)))
      .map((g) => altPayload(slotOrder, headSidByPos, g, sup));
    item.sameScoreTotal = total;
    top.push(item);
  }

  // 「同分 + 礼装一模一样」合并成一栏
  const mergedItems: any[] = [];
  const headByKey = new Map<string, any>();
  let slotOrderRef: string[] = [];
  for (const item of top) {
    if (slotOrderRef.length === 0) {
      slotOrderRef = (item.team ?? []).filter((m: any) => !m.isSupport).map((m: any) => m.position);
    }
    const key = `${pyRound(Number(item.totalMultiplier ?? 0), 9)}#${craftMultisetKey(item)}`;
    const head = headByKey.get(key);
    if (head === undefined) {
      headByKey.set(key, item);
      mergedItems.push(item);
      continue;
    }
    const union = [...(head.sameScoreTeams ?? [])];
    const seenKeys = new Set(union.map((a: any) => entryKey(a)));
    const headSidByPos = new Map<string, number>();
    for (const m of head.team ?? []) if (!m.isSupport) headSidByPos.set(m.position, m.servantId);
    const own = altFromItem(item, slotOrderRef, headSidByPos);
    if (own !== null) {
      const k = entryKey(own);
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        union.push(own);
      }
    }
    for (const alt of item.sameScoreTeams ?? []) {
      const k = entryKey(alt);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      union.push(rebaseAlt(alt, slotOrderRef, headSidByPos));
    }
    head.sameScoreTeams = union.slice(0, ALT_CAP);
    head.sameScoreTotal = Math.max(Number(head.sameScoreTotal ?? 0), union.length);
  }
  for (const item of mergedItems) {
    const deduped: any[] = [];
    const seenEntry = new Set<string>();
    for (const alt of item.sameScoreTeams ?? []) {
      const k = entryKey(alt);
      if (seenEntry.has(k)) continue;
      seenEntry.add(k);
      deduped.push(alt);
    }
    item.sameScoreTeams = deduped.slice(0, ALT_CAP);
    item.sameScoreTotal = deduped.length;
  }
  for (let i = 0; i < mergedItems.length; i++) mergedItems[i].rank = i + 1;

  return {
    status: stopFlag[0] ? "partial" : "success",
    totalCandidates: bestBySet.size,
    poolSize: altsPool.length,
    poolCombos,
    top20: mergedItems,
    sortMode: req.sort_mode,
    truncated,
    // 网页宿主按内存上限裁剪过本轮枚举量（桌面恒为 false）——界面可据此提示"手机上没搜满"
    ...(workCapped ? { workCapped: true } : {}),
    _elapsed: pyRound(nowSec() - start, 3),
    _processed: processedTotal,
    _verifyPhase: {
      firstProcessed,
      secondRan,
      secondProcessed,
      refineProcessed,
      optimizeProcessed,
    },
  };
}
