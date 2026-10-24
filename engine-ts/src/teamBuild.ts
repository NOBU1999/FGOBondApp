// P3b：建队层（对齐 search.py 的 PlayerSlot/CraftSlot/Blueprint、_greedy_mapping、
// _merge_craft_assignment、_make_team_config、_fill_remaining_craft_slots）
import {
  CLASS_GROUPS,
  FRONT_POSITIONS,
  POSITIONS,
  type BoxServant,
  type CalculationRequest,
} from "./models.ts";
import { type CraftInfo, type DataContext, traitBenefitTable } from "./calculator.ts";
import { PlacedMember, TeamConfig } from "./team.ts";
import { repeatableCraftIds, servantCanMatchCraftAnyStage } from "./relaxed.ts";

export const GENERIC_BOND_CRAFT_IDS: ReadonlySet<number> = new Set([-20, -21, -22]);
export const CANDIDATE_CLUSTER_WEIGHT = 0.16;

export class PlayerSlot {
  position: string;
  fixed_servant_id: number | null;
  fixed_craft_id: number | null;
  fixed_craft_type: string | null;
  is_crown: boolean;
  fixed_second_craft_id: number | null;
  fixed_second_craft_type: string | null;

  constructor(init: { position: string } & Partial<PlayerSlot>) {
    this.position = init.position;
    this.fixed_servant_id = init.fixed_servant_id ?? null;
    this.fixed_craft_id = init.fixed_craft_id ?? null;
    this.fixed_craft_type = init.fixed_craft_type ?? null;
    this.is_crown = init.is_crown ?? false;
    this.fixed_second_craft_id = init.fixed_second_craft_id ?? null;
    this.fixed_second_craft_type = init.fixed_second_craft_type ?? null;
  }
}

export class CraftSlot {
  position: string;
  index: number;
  fixed_craft_id: number | null;
  fixed_craft_type: string | null;

  constructor(init: { position: string; index?: number; fixed_craft_id?: number | null; fixed_craft_type?: string | null }) {
    this.position = init.position;
    this.index = init.index ?? 0;
    this.fixed_craft_id = init.fixed_craft_id ?? null;
    this.fixed_craft_type = init.fixed_craft_type ?? null;
  }
}

export class Blueprint {
  support_position: string;
  support_servant_id: number | null;
  support_craft_id: number | null;
  support_second_craft_id: number | null;
  player_slots: PlayerSlot[];
  fixed_player_members: PlacedMember[];
  free_servant_positions: string[];
  player_craft_slots: CraftSlot[];
  free_bond_positions: string[];
  fixed_bond_craft_ids: number[];
  fixed_other_craft_ids: number[];
  fixed_servant_ids: Set<number>;
  crown_positions: Set<string>;

  constructor(init: Partial<Blueprint> = {}) {
    this.support_position = init.support_position ?? "back_right";
    this.support_servant_id = init.support_servant_id ?? null;
    this.support_craft_id = init.support_craft_id ?? null;
    this.support_second_craft_id = init.support_second_craft_id ?? null;
    this.player_slots = init.player_slots ?? [];
    this.fixed_player_members = init.fixed_player_members ?? [];
    this.free_servant_positions = init.free_servant_positions ?? [];
    this.player_craft_slots = init.player_craft_slots ?? [];
    this.free_bond_positions = init.free_bond_positions ?? [];
    this.fixed_bond_craft_ids = init.fixed_bond_craft_ids ?? [];
    this.fixed_other_craft_ids = init.fixed_other_craft_ids ?? [];
    this.fixed_servant_ids = init.fixed_servant_ids ?? new Set();
    this.crown_positions = init.crown_positions ?? new Set();
  }
}

export function boxMap(req: CalculationRequest): Map<number, BoxServant> {
  const anyReq = req as any;
  if (!anyReq._boxMapCache) {
    const m = new Map<number, BoxServant>();
    for (const b of req.box) m.set(b.servant_id, b);
    anyReq._boxMapCache = m;
  }
  return anyReq._boxMapCache;
}

export function servantInClassGroup(
  ctx: DataContext,
  servantId: number,
  classGroup: string | null,
): boolean {
  if (!classGroup) return true;
  const allowed = CLASS_GROUPS[classGroup];
  if (allowed === undefined) return true;
  const info = ctx.servants.get(servantId);
  return Boolean(info && allowed.has(info.servant_class));
}

export function isOumaCraft(ctx: DataContext, craftId: number): boolean {
  const craft = ctx.crafts.get(craftId);
  if (!craft) return false;
  if (GENERIC_BOND_CRAFT_IDS.has(craftId)) return false;
  return (craft.name ?? "").includes("英灵逢魔");
}

export function traitCraftIds(ctx: DataContext): number[] {
  const out: number[] = [];
  for (const [cid, c] of ctx.crafts) {
    if (c.is_bond_ce && c.bonus_type === "trait" && !isOumaCraft(ctx, cid)) out.push(cid);
  }
  return out;
}

export function maxPossibleTraitBonus(
  ctx: DataContext,
  servantId: number,
  craftIds: number[],
  limit = 5,
): number {
  if (limit <= 0 || craftIds.length === 0) return 0;
  return traitBenefitTable(ctx).topSum(servantId, craftIds, limit);
}

export function servantHeuristic(ctx: DataContext, bs: BoxServant, craftIds: number[]): number {
  let score = 1 + bs.personal_bonus;
  if (bs.aura_bonus) score += bs.aura_bonus * 5;
  if (bs.max_bond && bs.bond_switch1) score += 1;
  if (bs.max_bond && !bs.bond_switch2) score -= 0.8;
  score += maxPossibleTraitBonus(ctx, bs.servant_id, craftIds) * 3;
  return score;
}

export function traitShareWeight(
  ctx: DataContext,
  candidates: number[],
  craftIds: number[],
): Map<number, number> {
  const table = traitBenefitTable(ctx);
  const counts = new Map<number, number>();
  for (const cid of craftIds) {
    let n = 0;
    for (const sid of candidates) if (table.canTrigger(sid, cid)) n += 1;
    counts.set(cid, n);
  }
  const weights = new Map<number, number>();
  for (const sid of candidates) {
    let total = 0;
    for (const cid of craftIds) {
      const c = counts.get(cid) ?? 0;
      if (c && table.canTrigger(sid, cid)) total += table.craftValue(cid) * c;
    }
    weights.set(sid, total);
  }
  return weights;
}

export function clusterBonus(share: Map<number, number>, servantId: number): number {
  return CANDIDATE_CLUSTER_WEIGHT * (share.get(servantId) ?? 0);
}

/** 启发式分配：潜力高的放前排；自身收益为 0 的满绊从者优先后排 */
export function greedyMapping(
  ctx: DataContext,
  box: Map<number, BoxServant>,
  extras: number[],
  freePositions: string[],
): Map<string, number> {
  const mapping = new Map<string, number>();
  if (extras.length === 0) return mapping;
  const craftIds = traitCraftIds(ctx);
  const gainers: number[] = [];
  const noGain: number[] = [];
  for (const sid of extras) {
    const bs = box.get(sid);
    if (bs && !bs.count_personal_bond) noGain.push(sid);
    else gainers.push(sid);
  }
  // Python: sort(key=..., reverse=True) —— 稳定倒序。JS 用降序比较并保持稳定。
  const keyOf = (sid: number) => servantHeuristic(ctx, box.get(sid)!, craftIds);
  const cmpDesc = (a: number, b: number) => keyOf(b) - keyOf(a);
  gainers.sort(cmpDesc);
  noGain.sort(cmpDesc);

  const frontPositions = freePositions.filter((p) => FRONT_POSITIONS.has(p));
  const backPositions = freePositions.filter((p) => !FRONT_POSITIONS.has(p));

  for (const pos of backPositions) {
    if (noGain.length > 0) mapping.set(pos, noGain.shift()!);
    else if (gainers.length > 0) mapping.set(pos, gainers.pop()!);
  }
  for (const pos of frontPositions) {
    if (gainers.length > 0) mapping.set(pos, gainers.shift()!);
    else if (noGain.length > 0) mapping.set(pos, noGain.shift()!);
  }
  return mapping;
}

function posIndex(pos: string): number {
  const i = POSITIONS.indexOf(pos as any);
  return i < 0 ? 99 : i;
}

/** 把礼装组合按"谁最吃得到"分配到自由礼装槽（配对优化） */
export function mergeCraftAssignment(
  ctx: DataContext,
  bp: Blueprint,
  playersByPos: Map<string, PlacedMember>,
  craftChoice: number[],
  passes = 1,
): void {
  if (craftChoice.length === 0) return;
  const freeSlots = bp.player_craft_slots.filter((cs) => cs.fixed_craft_id === null);
  if (freeSlots.length === 0) return;
  const orderedSlots = [...freeSlots].sort(
    (a, b) => (a.index === 1 ? 0 : 1) - (b.index === 1 ? 0 : 1) || posIndex(a.position) - posIndex(b.position),
  );
  const filledSlots = orderedSlots.slice(0, craftChoice.length);

  const currentCraftFor = (slot: CraftSlot, player: PlacedMember): number | null =>
    slot.index === 0 ? player.craft_id : player.second_craft_id;
  const setCraft = (slot: CraftSlot, player: PlacedMember, cid: number | null): void => {
    if (slot.index === 0) player.craft_id = cid;
    else player.second_craft_id = cid;
  };
  const craftValue = (cid: number): number => {
    const craft = ctx.crafts.get(cid);
    if (!craft) return 0;
    return Number(craft.bonus_value || 0) + Number(craft.flat_bonus || 0) * 0.05;
  };
  const marginal = (servantId: number, cid: number): number => {
    const craft = ctx.crafts.get(cid);
    if (!craft) return 0;
    if (craft.bonus_type === "trait") {
      if (!traitBenefitTable(ctx).canTrigger(servantId, cid)) return 0;
    }
    return Number(craft.bonus_value || 0) + Number(craft.flat_bonus || 0) * 0.05;
  };

  const pending = [...craftChoice].sort((a, b) => craftValue(b) - craftValue(a));
  const remaining = [...filledSlots];
  for (const cid of pending) {
    let bestSlot: CraftSlot | null = null;
    let bestGain: number | null = null;
    for (const slot of remaining) {
      const player = playersByPos.get(slot.position);
      if (!player) continue;
      const gain = marginal(player.servant_id, cid);
      if (bestGain === null || gain > bestGain) {
        bestGain = gain;
        bestSlot = slot;
      }
    }
    if (bestSlot === null) break;
    const player = playersByPos.get(bestSlot.position)!;
    setCraft(bestSlot, player, cid);
    remaining.splice(remaining.indexOf(bestSlot), 1);
  }

  if (passes <= 0) return;
  for (let _p = 0; _p < passes; _p++) {
    let improved = false;
    for (let i = 0; i < filledSlots.length; i++) {
      const slotA = filledSlots[i];
      const pa = playersByPos.get(slotA.position);
      if (!pa) continue;
      for (let j = i + 1; j < filledSlots.length; j++) {
        const slotB = filledSlots[j];
        const pb = playersByPos.get(slotB.position);
        if (!pb) continue;
        const ca = currentCraftFor(slotA, pa);
        const cb = currentCraftFor(slotB, pb);
        if (ca === null && cb === null) continue;
        const cur = marginal(pa.servant_id, ca ?? 0) + marginal(pb.servant_id, cb ?? 0);
        const nxt = marginal(pa.servant_id, cb ?? 0) + marginal(pb.servant_id, ca ?? 0);
        if (nxt > cur + 1e-12) {
          setCraft(slotA, pa, cb);
          setCraft(slotB, pb, ca);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

/** 固定阵容 + 礼装组合 → 一支队（返回 null 表示拼不出 5 人） */
export function makeTeamConfig(
  ctx: DataContext,
  req: CalculationRequest,
  bp: Blueprint,
  chosenExtras: number[],
  mapping: Map<string, number>,
  craftChoice: number[],
  supportServantId: number,
  supportCraftId: number | null,
  supportSecondCraftId: number | null = null,
): TeamConfig | null {
  const box = boxMap(req);
  const playersByPos = new Map<string, PlacedMember>();
  for (const p of bp.fixed_player_members) {
    playersByPos.set(
      p.position,
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
      }),
    );
  }
  for (const slot of bp.player_slots) {
    if (slot.fixed_servant_id !== null) continue;
    const sid = mapping.get(slot.position);
    if (sid === undefined) continue;
    const bs = box.get(sid);
    if (!bs) return null;
    playersByPos.set(
      slot.position,
      new PlacedMember({
        position: slot.position,
        servant_id: sid,
        stage: bs.stage,
        personal_bonus: bs.personal_bonus,
        aura_bonus: bs.aura_bonus,
        max_bond: bs.max_bond,
        bond_switch1: bs.bond_switch1,
        bond_switch2: bs.bond_switch2,
        craft_id: null,
        second_craft_id: null,
        is_crown: slot.is_crown,
        fixed: false,
      }),
    );
  }
  if (playersByPos.size !== 5) return null;

  for (const cs of bp.player_craft_slots) {
    if (cs.fixed_craft_id === null) continue;
    const player = playersByPos.get(cs.position);
    if (!player) continue;
    if (cs.index === 0) player.craft_id = cs.fixed_craft_id;
    else player.second_craft_id = cs.fixed_craft_id;
  }

  const freeSlots = bp.player_craft_slots.filter((cs) => cs.fixed_craft_id === null);
  const orderedFreeSlots = [...freeSlots].sort(
    (a, b) => (a.index === 1 ? 0 : 1) - (b.index === 1 ? 0 : 1) || posIndex(a.position) - posIndex(b.position),
  );
  const orderedCrafts = [...craftChoice].sort((a, b) => {
    const ca = ctx.crafts.get(a)?.cost ?? 0;
    const cb = ctx.crafts.get(b)?.cost ?? 0;
    return cb - ca;
  });
  const n = Math.min(orderedFreeSlots.length, orderedCrafts.length);
  for (let i = 0; i < n; i++) {
    const cs = orderedFreeSlots[i];
    const cid = orderedCrafts[i];
    const player = playersByPos.get(cs.position);
    if (!player) continue;
    if (cs.index === 0) player.craft_id = cid;
    else player.second_craft_id = cid;
  }

  return new TeamConfig({
    players: [...playersByPos.values()],
    support_position: bp.support_position,
    support_servant_id: supportServantId,
    support_craft_id: supportCraftId,
    support_second_craft_id: supportSecondCraftId,
    crown_positions: bp.crown_positions,
    base_bond: req.base_bond,
    activity_bonus: req.activity_bonus,
  });
}

/** 这张礼装是否真的能对当前队伍产生收益（自动补槽用） */
export function freeCraftBenefitsTeam(ctx: DataContext, team: TeamConfig, craft: CraftInfo): boolean {
  if (!craft || !craft.is_bond_ce) return false;
  if (Number(craft.support_bonus || 0) > 0) return false;
  if (!(Number(craft.bonus_value || 0) > 0 || Number(craft.flat_bonus || 0) > 0)) return false;
  for (const p of team.players ?? []) {
    if (p.max_bond && !p.bond_switch2) continue;
    if (craft.bonus_type === "universal" || craft.bonus_type === null) return true;
    if (craft.bonus_type === "trait") {
      if (p.stage_locked) {
        const mask = ctx.servant_mask(p.servant_id, p.stage);
        if (craft.trigger_masks.some((gm) => (mask & gm) === gm)) return true;
      } else if (servantCanMatchCraftAnyStage(ctx, p.servant_id, craft)) {
        return true;
      }
    }
  }
  return false;
}

/** 补满自由礼装空槽（保守贪心） */
export function fillRemainingCraftSlots(
  ctx: DataContext,
  req: CalculationRequest,
  bp: Blueprint,
  team: TeamConfig,
  candidateCraftIds: number[],
): TeamConfig {
  const playerByPos = new Map<string, PlacedMember>();
  for (const p of team.players) playerByPos.set(p.position, p);
  const usedIds = new Map<number, number>();
  for (const p of team.players) {
    for (const cid of [p.craft_id, p.second_craft_id]) {
      if (cid === null || cid === undefined) continue;
      usedIds.set(cid, (usedIds.get(cid) ?? 0) + 1);
    }
  }
  let servantCost = 0;
  for (const p of team.players) {
    const s = ctx.servants.get(p.servant_id);
    if (s) servantCost += s.cost;
  }
  let mainCost = 0;
  for (const p of team.players) {
    if (p.craft_id !== null && p.craft_id !== undefined) {
      const c = ctx.crafts.get(p.craft_id);
      if (c) mainCost += c.cost;
    }
  }
  let remaining = req.cost_limit - servantCost - mainCost;
  const repeatableIds = repeatableCraftIds(ctx);

  const freeSlots = bp.player_craft_slots.filter((cs) => cs.fixed_craft_id === null);
  freeSlots.sort(
    (a, b) => (a.index === 1 ? 0 : 1) - (b.index === 1 ? 0 : 1) || posIndex(a.position) - posIndex(b.position),
  );
  for (const cs of freeSlots) {
    const player = playerByPos.get(cs.position);
    if (!player) continue;
    const current = cs.index === 1 ? player.second_craft_id : player.craft_id;
    if (current !== null && current !== undefined) continue;
    let bestCid: number | null = null;
    let bestRank: number | null = null;
    for (const cid of candidateCraftIds) {
      const craft = ctx.crafts.get(cid);
      if (!craft || !craft.is_bond_ce) continue;
      if ((usedIds.get(cid) ?? 0) > 0 && !repeatableIds.has(cid)) continue;
      if (cs.index === 0) {
        if (craft.cost > remaining) continue;
      }
      if (!freeCraftBenefitsTeam(ctx, team, craft)) continue;
      const value = craft.bonus_value + craft.flat_bonus / 10000;
      if (bestRank === null || value > bestRank) {
        bestRank = value;
        bestCid = cid;
      }
    }
    if (bestCid === null) continue;
    const craft = ctx.crafts.get(bestCid)!;
    if (cs.index === 1) player.second_craft_id = bestCid;
    else {
      player.craft_id = bestCid;
      remaining -= craft.cost;
    }
    usedIds.set(bestCid, (usedIds.get(bestCid) ?? 0) + 1);
  }
  return team;
}
