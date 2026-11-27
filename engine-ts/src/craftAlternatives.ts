// 同分礼装（单格替换）——给每行的每个礼装格算出"换成它总分不变"的其他礼装。
//
// 口径（2026-11-24 与用户确认）：
//  · 只处理 20% 特性礼装这一档：这一档才有多张条件不同、同值的礼装可互换；
//    0.1 通用/可重复礼装没有"替代"的意义，不列。
//  · 礼装效果对**全队**生效（引擎的 TeamCraftView 就是这么算的），因此判定不能按持有者，
//    也不能只比"命中人数"——同一个 +20% 落在前排和后排，绝对收益不同（先发乘子）。
//    唯一可靠的判据是：换完**整队重算**，倍率与（填了基础牵绊时的）总点数都不变。
//  · 候选量用"队伍特性并集"压：队里没有任何一名真正计分的玩家满足条件的礼装直接排除
//    （满绊且开关②没开的成员加成按 0 算，命中他等于没命中）。
//  · 校验：整队 Cost 不得超上限；玩家格之间不能重复同一张，助战格可重复。
//
// 输出：每行多一个 `craftAlternatives`：
//   [{ position: "front_left", slot: 0, craftIds: [9408990, 9408590] }, ...]
//   slot=0 主礼装位、slot=1 第二礼装位（冠位）。
import type { CalculationRequest } from "./models.ts";
import { type CraftInfo, type DataContext } from "./calculator.ts";
import { PlacedMember, TeamConfig, teamCost } from "./team.ts";
import { evaluateTeam } from "./evaluate.ts";
import { isOumaCraft } from "./teamBuild.ts";
import { usesPointsScoring } from "./relaxed.ts";

/** 每个格子最多列几张（够用即可，避免结果膨胀） */
export const CRAFT_ALT_MAX_PER_SLOT = 6;
/** 20% 这一档 */
const TRAIT_CE_VALUE = 0.2;
/** 一次计算里最多做多少次"整队重算"，超了就收手（防御性上限） */
const MAX_EVAL = 40000;

export interface CraftAlternative {
  position: string;
  slot: number;
  craftIds: number[];
}

interface BoxEntry {
  stage: string;
  personal_bonus: number;
  aura_bonus: number;
  max_bond: boolean;
  bond_switch1: boolean;
  bond_switch2: boolean;
}

function boxIndex(req: CalculationRequest): Map<number, BoxEntry> {
  const out = new Map<number, BoxEntry>();
  for (const b of req.box ?? []) {
    out.set(Number(b.servant_id), {
      stage: b.stage ?? "fourth",
      personal_bonus: Number(b.personal_bonus ?? 0),
      aura_bonus: Number(b.aura_bonus ?? 0),
      max_bond: Boolean(b.max_bond),
      bond_switch1: Boolean(b.bond_switch1),
      bond_switch2: Boolean(b.bond_switch2),
    });
  }
  return out;
}

/** 20% 特性礼装候选（不含排除、活动限定、英灵逢魔、助战专用） */
function candidateCrafts(ctx: DataContext, req: CalculationRequest): CraftInfo[] {
  const out: CraftInfo[] = [];
  for (const [cid, craft] of ctx.crafts) {
    if (craft.bonus_type !== "trait") continue;
    if (Math.abs(Number(craft.bonus_value) - TRAIT_CE_VALUE) > 1e-9) continue;
    if (!craft.is_bond_ce) continue;
    if (craft.is_event_limited) continue;
    if (Number(craft.support_bonus || 0) > 0) continue;
    if (isOumaCraft(ctx, cid)) continue;
    if (req.excluded_craft_ids.has(cid)) continue;
    out.push(craft);
  }
  return out;
}

/** 这张礼装能不能被"真正计分"的队内玩家吃到（满绊零收益的不算） */
function hitsCountingMember(
  ctx: DataContext,
  craft: CraftInfo,
  members: { servant_id: number; stage: string; counts: boolean }[],
): boolean {
  if (craft.trigger_masks.length === 0) return members.some((m) => m.counts);
  for (const m of members) {
    if (!m.counts) continue;
    const mask = ctx.servant_mask(m.servant_id, m.stage);
    for (const groupMask of craft.trigger_masks) {
      if ((mask & groupMask) === groupMask) return true;
    }
  }
  return false;
}

function buildTeam(item: any, req: CalculationRequest, box: Map<number, BoxEntry>): TeamConfig | null {
  const players: PlacedMember[] = [];
  let sup: any = null;
  for (const m of item.team ?? []) {
    if (m.isSupport) {
      sup = m;
      continue;
    }
    const sid = Number(m.servantId);
    const bs = box.get(sid);
    players.push(
      new PlacedMember({
        position: m.position,
        servant_id: sid,
        stage: m.stage ?? bs?.stage ?? "fourth",
        personal_bonus: m.personalBonus ?? bs?.personal_bonus ?? 0,
        aura_bonus: m.auraBonus ?? bs?.aura_bonus ?? 0,
        max_bond: m.isMaxBond ?? bs?.max_bond ?? false,
        bond_switch1: m.bondSwitch1 ?? bs?.bond_switch1 ?? false,
        bond_switch2: m.bondSwitch2 ?? bs?.bond_switch2 ?? false,
        craft_id: m.craftId ?? null,
        second_craft_id: m.secondCraftId ?? null,
        is_crown: Boolean(m.isCrown),
      }),
    );
  }
  if (players.length === 0) return null;
  return new TeamConfig({
    players,
    support_position: sup ? sup.position : null,
    support_servant_id: sup ? Number(sup.servantId) : null,
    support_craft_id: sup ? (sup.craftId ?? null) : null,
    support_second_craft_id: sup ? (sup.secondCraftId ?? null) : null,
    crown_positions: new Set(players.filter((p) => p.is_crown).map((p) => p.position)),
    base_bond: req.base_bond ?? 0,
    activity_bonus: req.activity_bonus ?? 0,
    main_story_bond_bonus: req.main_story_bond_bonus ?? 0,
  });
}

/** 复制一队并替换某一格的礼装 */
function withCraft(team: TeamConfig, slot: { kind: "player" | "support"; position: string; index: number }, craftId: number): TeamConfig {
  const players = team.players.map((p) => {
    if (slot.kind !== "player" || p.position !== slot.position) return p;
    return new PlacedMember({
      position: p.position,
      servant_id: p.servant_id,
      stage: p.stage,
      personal_bonus: p.personal_bonus,
      aura_bonus: p.aura_bonus,
      max_bond: p.max_bond,
      bond_switch1: p.bond_switch1,
      bond_switch2: p.bond_switch2,
      craft_id: slot.index === 0 ? craftId : p.craft_id,
      second_craft_id: slot.index === 1 ? craftId : p.second_craft_id,
      is_crown: p.is_crown,
      fixed: p.fixed,
      stage_locked: p.stage_locked,
    });
  });
  return new TeamConfig({
    players,
    support_position: team.support_position,
    support_servant_id: team.support_servant_id,
    support_craft_id: slot.kind === "support" && slot.index === 0 ? craftId : team.support_craft_id,
    support_second_craft_id: slot.kind === "support" && slot.index === 1 ? craftId : team.support_second_craft_id,
    crown_positions: team.crown_positions,
    base_bond: team.base_bond,
    activity_bonus: team.activity_bonus,
    main_story_bond_bonus: team.main_story_bond_bonus,
  });
}

/** 同一行的「同分阵容」最多算多少支（防御性上限：每支都要逐格重算，太多会拖慢） */
const ALT_LINEUP_MAX = 30;

/** 从同分阵容条目建队（成员来自条目自己的 servantIds/craftIds，助战与冠位沿用本行） */
export function buildTeamFromAlt(item: any, alt: any, box: Map<number, BoxEntry>): TeamConfig | null {
  const positions: string[] = Array.isArray(alt?.positions) ? alt.positions : [];
  const sids: number[] = Array.isArray(alt?.servantIds) ? alt.servantIds : [];
  const cids: any[] = Array.isArray(alt?.craftIds) ? alt.craftIds : [];
  const c2s: any[] = Array.isArray(alt?.secondCraftIds) ? alt.secondCraftIds : [];
  if (!positions.length || positions.length !== sids.length) return null;
  let sup: any = null;
  const crownByPos = new Set<string>();
  for (const m of item.team ?? []) {
    if (m.isSupport) sup = m;
    else if (m.isCrown) crownByPos.add(String(m.position));
  }
  const players: PlacedMember[] = [];
  for (let k = 0; k < positions.length; k += 1) {
    const sid = Number(sids[k]);
    if (!Number.isFinite(sid)) continue;
    const bs = box.get(sid);
    players.push(
      new PlacedMember({
        position: positions[k],
        servant_id: sid,
        stage: bs?.stage ?? "fourth",
        personal_bonus: bs?.personal_bonus ?? 0,
        aura_bonus: bs?.aura_bonus ?? 0,
        max_bond: bs?.max_bond ?? false,
        bond_switch1: bs?.bond_switch1 ?? false,
        bond_switch2: bs?.bond_switch2 ?? false,
        craft_id: cids[k] ?? null,
        second_craft_id: c2s[k] ?? null,
        is_crown: crownByPos.has(String(positions[k])),
      }),
    );
  }
  if (players.length === 0) return null;
  return new TeamConfig({
    players,
    support_position: sup ? sup.position : null,
    support_servant_id: sup ? Number(sup.servantId) : null,
    support_craft_id: alt?.supportCraftId ?? (sup ? (sup.craftId ?? null) : null),
    support_second_craft_id: alt?.supportSecondCraftId ?? (sup ? (sup.secondCraftId ?? null) : null),
    crown_positions: new Set(players.filter((p) => p.is_crown).map((p) => p.position)),
    base_bond: 0,
    activity_bonus: 0,
    main_story_bond_bonus: 0,
  });
}

/** 给一支队伍算「每格可换礼装」；budget 是全局共享的 eval 上限 */
function computeSlots(
  ctx: DataContext,
  pool: CraftInfo[],
  box: Map<number, BoxEntry>,
  costLimit: number,
  pointsMode: boolean,
  base: TeamConfig,
  budget: { evals: number },
): CraftAlternative[] {
  if (budget.evals >= MAX_EVAL) return [];
  const baseEval = evaluateTeam(ctx, base);
  const baseMult = Number(baseEval.totalMultiplier || 0);
  const basePoints = Number(baseEval.totalBondPoints || 0);

  // 队伍特性并集（只算真正计分的玩家：满绊且开关②没开的加成按 0 算）
  const members = base.players.map((p) => ({
    servant_id: p.servant_id,
    stage: p.stage,
    counts: !(p.max_bond && !p.bond_switch2),
  }));
  const usable = pool.filter((c) => hitsCountingMember(ctx, c, members));
  if (usable.length === 0) return [];

  const usedByPlayers = (skipPosition: string | null, skipIndex: number): Set<number> => {
    const s = new Set<number>();
    for (const p of base.players) {
      if (p.position === skipPosition) {
        if (skipIndex !== 0 && p.craft_id !== null) s.add(p.craft_id);
        if (skipIndex !== 1 && p.second_craft_id !== null) s.add(p.second_craft_id);
        continue;
      }
      if (p.craft_id !== null) s.add(p.craft_id);
      if (p.second_craft_id !== null) s.add(p.second_craft_id);
    }
    return s;
  };

  const slots: CraftAlternative[] = [];
  const trySlot = (slot: { kind: "player" | "support"; position: string; index: number }, current: number | null) => {
    // 玩家格：不能与其他玩家格重复；助战格可重复（游戏规则）。
    // 但助战自己的两个礼装格之间不能互相"替换"——那是同一人、同一套加成，没有意义（2026-11-24 用户定）。
    const blocked = slot.kind === "player" ? usedByPlayers(slot.position, slot.index) : new Set<number>();
    if (slot.kind === "support") {
      const sibling = slot.index === 0 ? base.support_second_craft_id : base.support_craft_id;
      if (sibling !== null) blocked.add(sibling);
    }
    const ids: number[] = [];
    for (const craft of usable) {
      if (current !== null && craft.id === current) continue;
      if (blocked !== null && blocked.has(craft.id)) continue;
      if (budget.evals >= MAX_EVAL) break;
      const variant = withCraft(base, slot, craft.id);
      if (costLimit > 0 && teamCost(ctx, variant) > costLimit) continue;
      budget.evals += 1;
      const ev = evaluateTeam(ctx, variant);
      // 同分按**当前模式的排名口径**判：点数档比取整后的总点数，其余比总倍率。
      if (pointsMode) {
        if (Number(ev.totalBondPoints || 0) !== basePoints) continue;
      } else if (Math.abs(Number(ev.totalMultiplier || 0) - baseMult) > 1e-9) continue;
      ids.push(craft.id);
      if (ids.length >= CRAFT_ALT_MAX_PER_SLOT) break;
    }
    if (ids.length > 0) slots.push({ position: slot.position, slot: slot.index, craftIds: ids });
  };

  for (const p of base.players) {
    if (p.craft_id !== null) trySlot({ kind: "player", position: p.position, index: 0 }, p.craft_id);
    if (p.second_craft_id !== null) trySlot({ kind: "player", position: p.position, index: 1 }, p.second_craft_id);
  }
  if (base.support_position !== null && base.support_craft_id !== null) {
    trySlot({ kind: "support", position: base.support_position, index: 0 }, base.support_craft_id);
  }
  if (base.support_position !== null && base.support_second_craft_id !== null) {
    trySlot({ kind: "support", position: base.support_position, index: 1 }, base.support_second_craft_id);
  }
  return slots;
}

/**
 * 给每个结果行附加「每格可换礼装」。就地修改 items，返回统计（便于日志/测试）。
 *
 * v0.3.8（2026-11-27 用户要求）：同分阵容也各算一遍，结果挂在各自的
 * sameScoreTeams[i].craftAlternatives 上 —— 切到同分阵容时也能换礼装，
 * 判定按那一支自己的阵容整队重算（不能沿用本行原阵容那张表）。
 */
export function attachCraftAlternatives(
  ctx: DataContext,
  req: CalculationRequest,
  items: any[],
): { rows: number; slots: number; evals: number; lineups: number } {
  const pool = candidateCrafts(ctx, req);
  if (pool.length < 2 || items.length === 0) return { rows: 0, slots: 0, evals: 0, lineups: 0 };

  const box = boxIndex(req);
  const pointsMode = usesPointsScoring(req);
  const costLimit = Number(req.cost_limit ?? 0);
  const budget = { evals: 0 };
  let slotCount = 0;
  let rows = 0;
  let lineups = 0;

  for (const item of items) {
    const base = buildTeam(item, req, box);
    if (base === null) continue;
    const slots = computeSlots(ctx, pool, box, costLimit, pointsMode, base, budget);
    if (slots.length > 0) {
      item.craftAlternatives = slots;
      rows += 1;
      slotCount += slots.length;
    }
    // 同分阵容：每支按自己的阵容算一遍
    const alts: any[] = Array.isArray(item.sameScoreTeams) ? item.sameScoreTeams : [];
    for (const alt of alts.slice(0, ALT_LINEUP_MAX)) {
      if (budget.evals >= MAX_EVAL) break;
      const altTeam = buildTeamFromAlt(item, alt, box);
      if (altTeam === null) continue;
      const altSlots = computeSlots(ctx, pool, box, costLimit, pointsMode, altTeam, budget);
      if (altSlots.length > 0) {
        alt.craftAlternatives = altSlots;
        lineups += 1;
        slotCount += altSlots.length;
      } else {
        delete alt.craftAlternatives;
      }
    }
    if (budget.evals >= MAX_EVAL) break;
  }

  return { rows, slots: slotCount, evals: budget.evals, lineups };
}
