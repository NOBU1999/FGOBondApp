// P2b：队伍表示与求值（逐条对齐 python-engine/engine/calculator.py 的 425~920 行）
import { FRONT_POSITIONS } from "./models.ts";
import { STAGES, STAGE_ORDER } from "./constants.ts";
import { CraftInfo, DataContext, traitMaskOf, type ServantInfo } from "./calculator.ts";
import { pySum } from "./pysum.ts";

/** 对齐 `all(t in traits for t in group)` */
export function matchTraitGroup(traits: Set<string>, group: string[]): boolean {
  return group.every((t) => traits.has(t));
}

export function traitBonusForMask(mask: bigint, crafts: iterableOfCraft): number {
  let total = 0;
  for (const craft of crafts) {
    if (craft.bonus_type !== "trait" || !craft.is_bond_ce) continue;
    for (const groupMask of craft.trigger_masks) {
      if ((mask & groupMask) === groupMask) {
        total += craft.bonus_value;
        break;
      }
    }
  }
  return total;
}
type iterableOfCraft = Iterable<CraftInfo>;

export function flatBonusForMask(mask: bigint, crafts: iterableOfCraft): number {
  let total = 0;
  for (const craft of crafts) {
    if (!craft.is_bond_ce || craft.flat_bonus <= 0) continue;
    if (craft.bonus_type === "trait") {
      let hit = false;
      for (const groupMask of craft.trigger_masks) {
        if ((mask & groupMask) === groupMask) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
    } else if (craft.bonus_type !== "universal") {
      continue;
    }
    total += craft.flat_bonus;
  }
  return total;
}

/** 某阶段状态下，本队特性礼装能给该从者的加成总和 */
function stateScore(ctx: DataContext, servantId: number, stateKey: string, playerCrafts: CraftInfo[]): number {
  const servant = ctx.servants.get(servantId);
  if (!servant) return 0;
  return traitBonusForMask(servant.mask_for(stateKey), playerCrafts);
}

/** 该从者在本队特性礼装下的最优阶段/灵衣；null = 不改动 */
export function stageTargetFor(
  ctx: DataContext,
  servantId: number,
  traitCrafts: CraftInfo[],
): string | null {
  const servant = ctx.servants.get(servantId);
  if (!servant || Object.keys(servant.traits).length === 0) return null;
  const ascKeys = STAGES.filter((s) => s in servant.traits);
  const costumeKeys = Object.keys(servant.traits)
    .filter((k) => k.startsWith("costume_"))
    .sort();
  const candidates = [...ascKeys, ...costumeKeys];
  if (candidates.length === 0) return null;

  if (traitCrafts.length === 0) {
    if (ascKeys.length > 0) return ascKeys[ascKeys.length - 1];
    return costumeKeys.reduce((best, k) =>
      intOfCostume(k) < intOfCostume(best) ? k : best,
    );
  }

  const scores = new Map<string, number>();
  for (const key of candidates) {
    scores.set(key, traitBonusForMask(servant.mask_for(key), traitCrafts));
  }
  let maxScore = -Infinity;
  for (const v of scores.values()) if (v > maxScore) maxScore = v;

  const bestAsc = ascKeys.filter((k) => scores.get(k) === maxScore);
  if (bestAsc.length > 0) {
    return bestAsc.reduce((best, k) =>
      (STAGE_ORDER[k] ?? -1) > (STAGE_ORDER[best] ?? -1) ? k : best,
    );
  }
  const bestCostume = costumeKeys.filter((k) => scores.get(k) === maxScore);
  if (bestCostume.length > 0) {
    return bestCostume.reduce((best, k) => (intOfCostume(k) < intOfCostume(best) ? k : best));
  }
  return null;
}

function intOfCostume(key: string): number {
  return parseInt(key.split("_")[1] ?? "0", 10);
}

export class PlacedMember {
  position: string;
  servant_id: number;
  stage: string;
  personal_bonus: number;
  max_bond: boolean;
  bond_switch1: boolean;
  bond_switch2: boolean;
  aura_bonus: number;
  craft_id: number | null;
  second_craft_id: number | null;
  is_crown: boolean;
  fixed: boolean;
  stage_locked: boolean;

  constructor(init: Partial<PlacedMember> & { position: string; servant_id: number; stage: string }) {
    this.position = init.position;
    this.servant_id = init.servant_id;
    this.stage = init.stage;
    this.personal_bonus = init.personal_bonus ?? 0;
    this.max_bond = init.max_bond ?? false;
    this.bond_switch1 = init.bond_switch1 ?? false;
    this.bond_switch2 = init.bond_switch2 ?? false;
    this.aura_bonus = init.aura_bonus ?? 0;
    this.craft_id = init.craft_id ?? null;
    this.second_craft_id = init.second_craft_id ?? null;
    this.is_crown = init.is_crown ?? false;
    this.fixed = init.fixed ?? false;
    this.stage_locked = init.stage_locked ?? false;
  }
}

export class TeamConfig {
  players: PlacedMember[];
  support_position: string | null;
  support_servant_id: number | null;
  support_craft_id: number | null;
  support_second_craft_id: number | null;
  crown_positions: Set<string>;
  base_bond: number;
  activity_bonus: number;

  constructor(init: {
    players: PlacedMember[];
    support_position?: string | null;
    support_servant_id?: number | null;
    support_craft_id?: number | null;
    support_second_craft_id?: number | null;
    crown_positions?: Set<string>;
    base_bond?: number;
    activity_bonus?: number;
  }) {
    this.players = init.players;
    this.support_position = init.support_position ?? null;
    this.support_servant_id = init.support_servant_id ?? null;
    this.support_craft_id = init.support_craft_id ?? null;
    this.support_second_craft_id = init.support_second_craft_id ?? null;
    this.crown_positions = init.crown_positions ?? new Set();
    this.base_bond = init.base_bond ?? 0;
    this.activity_bonus = init.activity_bonus ?? 0;
  }
}

export function optimizeTeamStages(ctx: DataContext, team: TeamConfig): TeamConfig {
  if (team.players.length === 0) return team;
  const craftSig = [
    team.players
      .flatMap((p) => [p.craft_id, p.second_craft_id])
      .filter((c): c is number => c !== null)
      .sort((a, b) => a - b),
    team.support_craft_id,
    team.support_second_craft_id,
  ].join("|");

  const anyCtx = ctx as any;
  if (!anyCtx._stageCraftSigCache) anyCtx._stageCraftSigCache = new Map<string, [CraftInfo[], number[]]>();
  const craftCache: Map<string, [CraftInfo[], number[]]> = anyCtx._stageCraftSigCache;
  let cached = craftCache.get(craftSig);
  if (!cached) {
    const playerCrafts: CraftInfo[] = [];
    for (const p of team.players) {
      for (const cid of [p.craft_id, p.second_craft_id]) {
        if (cid !== null && cid !== undefined && ctx.crafts.has(cid)) playerCrafts.push(ctx.crafts.get(cid)!);
      }
    }
    const supportCraft = team.support_craft_id !== null ? ctx.crafts.get(team.support_craft_id) ?? null : null;
    const supportSecond =
      team.support_second_craft_id !== null ? ctx.crafts.get(team.support_second_craft_id) ?? null : null;
    const effect = effectCrafts(playerCrafts, supportCraft, supportSecond);
    const traitCrafts = effect.filter((c) => c.bonus_type === "trait" && c.is_bond_ce);
    const traitKey = traitCrafts.map((c) => c.id).sort((a, b) => a - b);
    cached = [traitCrafts, traitKey];
    craftCache.set(craftSig, cached);
  }
  const [traitCrafts, traitKey] = cached;

  if (!anyCtx._stageOptCache) anyCtx._stageOptCache = new Map<string, string | null>();
  const stageCache: Map<string, string | null> = anyCtx._stageOptCache;

  for (const p of team.players) {
    if (p.stage_locked) continue;
    const cacheKey = `${p.servant_id}:${traitKey.join(",")}`;
    let target: string | null | undefined = stageCache.get(cacheKey);
    if (target === undefined && !stageCache.has(cacheKey)) {
      target = stageTargetFor(ctx, p.servant_id, traitCrafts);
      stageCache.set(cacheKey, target);
    }
    if (target !== null && target !== undefined) p.stage = target;
  }
  return team;
}

export function universalBonus(crafts: iterableOfCraft): number {
  let total = 0;
  for (const craft of crafts) {
    if (!craft.is_bond_ce) continue;
    if (craft.bonus_type === "universal" || craft.bonus_type === "support_only") {
      total += craft.bonus_value;
    }
  }
  return total;
}

export function supportCraftBonus(craft: CraftInfo | null | undefined): number {
  if (!craft) return 0;
  if (craft.support_bonus > 0) return craft.support_bonus;
  if (craft.bonus_type === "support_only") return craft.bonus_value;
  return 0;
}

export function supportCraftsBonus(...crafts: (CraftInfo | null | undefined)[]): number {
  const values: number[] = [];
  for (const c of crafts) {
    if (c) values.push(supportCraftBonus(c));
  }
  return pySum(values);
}

export function effectCrafts(
  playerCrafts: CraftInfo[],
  supportCraft: CraftInfo | null | undefined,
  supportSecondCraft: CraftInfo | null | undefined = null,
): CraftInfo[] {
  const result = [...playerCrafts];
  for (const craft of [supportCraft, supportSecondCraft]) {
    if (craft && craft.is_bond_ce && craft.support_bonus <= 0) result.push(craft);
  }
  return result;
}

/** 一支队伍"有效礼装"的预计算视图（与成员无关的部分只算一次） */
export class TeamCraftView {
  effect_crafts: CraftInfo[];
  universal: number;
  support: number;
  trait_items: [bigint[], number][];
  flat_items: [bigint[], number][];

  constructor(
    playerCrafts: CraftInfo[],
    supportCraft: CraftInfo | null = null,
    supportSecondCraft: CraftInfo | null = null,
  ) {
    const effect = effectCrafts(playerCrafts, supportCraft, supportSecondCraft);
    this.effect_crafts = effect;
    this.universal = universalBonus(effect);
    this.support = supportCraftsBonus(supportCraft, supportSecondCraft);
    const traitItems: [bigint[], number][] = [];
    const flatItems: [bigint[], number][] = [];
    for (const craft of effect) {
      if (!craft.is_bond_ce) continue;
      const masks = craft.trigger_masks;
      if (craft.bonus_type === "trait") {
        if (masks.length === 0) continue;
        traitItems.push([masks, craft.bonus_value]);
        if (craft.flat_bonus > 0) flatItems.push([masks, craft.flat_bonus]);
      } else if (craft.bonus_type === "universal" && craft.flat_bonus > 0) {
        flatItems.push([[], craft.flat_bonus]);
      }
    }
    this.trait_items = traitItems;
    this.flat_items = flatItems;
  }

  traitBonus(mask: bigint): number {
    let total = 0;
    for (const [masks, value] of this.trait_items) {
      for (const groupMask of masks) {
        if ((mask & groupMask) === groupMask) {
          total += value;
          break;
        }
      }
    }
    return total;
  }

  flatBonus(mask: bigint): number {
    let total = 0;
    for (const [masks, value] of this.flat_items) {
      if (masks.length === 0) {
        total += value;
        continue;
      }
      for (const groupMask of masks) {
        if ((mask & groupMask) === groupMask) {
          total += value;
          break;
        }
      }
    }
    return total;
  }
}

export function frontlineBonus(position: string, supportInFront: boolean): number {
  let bonus = supportInFront ? 0.04 : 0;
  if (FRONT_POSITIONS.has(position)) bonus += 0.2;
  return bonus;
}

export function calculateMemberMultiplier(opts: {
  servantTraits: Set<string> | null;
  position: string;
  personalBonus: number;
  playerCrafts: CraftInfo[];
  maxBondCount: number;
  activityBonus: number;
  auraBonus?: number;
  supportCraft?: CraftInfo | null;
  supportSecondCraft?: CraftInfo | null;
  supportInFront?: boolean;
  traitMask?: bigint | null;
  craftView?: TeamCraftView | null;
}): number {
  const front = frontlineBonus(opts.position, opts.supportInFront ?? false);
  let uni: number;
  let sc: number;
  let tr: number;
  if (opts.craftView) {
    uni = opts.craftView.universal;
    sc = opts.craftView.support;
    tr = opts.craftView.traitBonus(
      opts.traitMask != null ? opts.traitMask : traitMaskOf(opts.servantTraits ?? []),
    );
  } else {
    const effect = effectCrafts(opts.playerCrafts, opts.supportCraft ?? null, opts.supportSecondCraft ?? null);
    uni = universalBonus(effect);
    sc = supportCraftsBonus(opts.supportCraft ?? null, opts.supportSecondCraft ?? null);
    tr =
      opts.traitMask != null
        ? traitBonusForMask(opts.traitMask, effect)
        : traitBonusForMask(traitMaskOf(opts.servantTraits ?? []), effect);
  }
  const maxBondBonus = opts.maxBondCount * 0.25;
  return (
    (1 + front) *
    (1 + uni + sc + tr + maxBondBonus + opts.activityBonus + (opts.auraBonus ?? 0) + opts.personalBonus)
  );
}

export function teamCost(ctx: DataContext, team: TeamConfig): number {
  let total = 0;
  for (const p of team.players) {
    const servant = ctx.servants.get(p.servant_id);
    total += servant ? servant.cost : 0;
    if (p.craft_id !== null && p.craft_id !== undefined) {
      const craft = ctx.crafts.get(p.craft_id);
      if (craft) total += craft.cost;
    }
  }
  return total;
}

export interface TeamMetrics {
  totalMultiplier: number;
  multipliers: number[];
  totalFlatBonus: number;
  flatBonuses: number[];
  maxBondCount: number;
  maxBondBonus: number;
}

export function calculateTeamMetrics(ctx: DataContext, team: TeamConfig): TeamMetrics {
  const playerCrafts: CraftInfo[] = [];
  for (const p of team.players) {
    for (const cid of [p.craft_id, p.second_craft_id]) {
      if (cid !== null && cid !== undefined && cid !== undefined) {
        const craft = ctx.crafts.get(cid);
        if (craft) playerCrafts.push(craft);
      }
    }
  }

  let maxBondCount = 0;
  for (const p of team.players) if (p.max_bond && p.bond_switch1) maxBondCount += 1;

  const supportCraft =
    team.support_craft_id !== null ? ctx.crafts.get(team.support_craft_id) ?? null : null;
  const supportSecondCraft =
    team.support_second_craft_id !== null
      ? ctx.crafts.get(team.support_second_craft_id) ?? null
      : null;
  const supportInFront = Boolean(
    team.support_position !== null && FRONT_POSITIONS.has(team.support_position),
  );
  const maxBondBonus = maxBondCount * 0.25;
  const activityBonus = team.activity_bonus || 0;
  const auraBonus = pySum(team.players.map((p) => Number(p.aura_bonus || 0)));

  const craftView = new TeamCraftView(playerCrafts, supportCraft, supportSecondCraft);

  const multipliers: number[] = [];
  const flatBonuses: number[] = [];
  for (const p of team.players) {
    if (p.max_bond && !p.bond_switch2) {
      multipliers.push(0);
      flatBonuses.push(0);
      continue;
    }
    const servantMask = ctx.servant_mask(p.servant_id, p.stage);
    multipliers.push(
      calculateMemberMultiplier({
        servantTraits: null,
        position: p.position,
        personalBonus: p.personal_bonus,
        playerCrafts,
        maxBondCount,
        activityBonus,
        auraBonus,
        supportCraft,
        supportSecondCraft,
        supportInFront,
        traitMask: servantMask,
        craftView,
      }),
    );
    flatBonuses.push(craftView.flatBonus(servantMask));
  }

  const totalFlat = pySum(flatBonuses);
  const totalMultiplier = pySum(multipliers);

  return {
    totalMultiplier,
    multipliers,
    totalFlatBonus: totalFlat,
    flatBonuses,
    maxBondCount,
    maxBondBonus,
  };
}

export type { ServantInfo };
