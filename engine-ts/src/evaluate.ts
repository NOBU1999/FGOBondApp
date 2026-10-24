// P2c：`evaluate_team`（界面明细）+ Python 语义的 round()
import { FRONT_POSITIONS, POSITIONS } from "./models.ts";
import { DataContext, traitMaskOf } from "./calculator.ts";
import {
  TeamConfig,
  TeamCraftView,
  calculateMemberMultiplier,
  frontlineBonus,
  matchTraitGroup,
  supportCraftsBonus,
  teamCost,
  universalBonus,
} from "./team.ts";
import { pySum } from "./pysum.ts";

/**
 * 复刻 Python 的 `round(x, ndigits)`（银行家舍入，按二进制真值取最近的十进制值）。
 * 用「乘 10^nd 后按偶数取整」近似；平局（差 0.5）时取偶，与 CPython 一致。
 */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const p = 10 ** nd;
  const scaled = x * p;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let r: number;
  if (diff > 0.5 + EPS) r = floor + 1;
  else if (diff < 0.5 - EPS) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1; // 平局取偶
  return r / p;
}

function sortedStrings(values: Set<string>): string[] {
  return [...values].sort();
}

export function evaluateTeam(ctx: DataContext, team: TeamConfig): any {
  const playerCrafts: any[] = [];
  for (const p of team.players) {
    for (const cid of [p.craft_id, p.second_craft_id]) {
      if (cid !== null && cid !== undefined) {
        const c = ctx.crafts.get(cid);
        if (c) playerCrafts.push(c);
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
  const baseBond = Number(team.base_bond || 0);
  const supportInFront = Boolean(
    team.support_position !== null && FRONT_POSITIONS.has(team.support_position),
  );
  const maxBondBonus = maxBondCount * 0.25;
  const activityBonus = team.activity_bonus || 0;
  const auraBonus = pySum(team.players.map((p) => Number(p.aura_bonus || 0)));
  const craftView = new TeamCraftView(playerCrafts, supportCraft, supportSecondCraft);
  const effectCrafts = craftView.effect_crafts;

  const members: any[] = [];
  let totalMultiplier = 0;
  let totalFlatBonus = 0;
  const traitCoverage = new Set<string>();

  for (const p of team.players) {
    const servant = ctx.servants.get(p.servant_id);
    if (!servant) continue;
    const traits = ctx.servant_traits(p.servant_id, p.stage);
    const craft = p.craft_id !== null ? ctx.crafts.get(p.craft_id) : undefined;
    const secondCraft = p.second_craft_id !== null ? ctx.crafts.get(p.second_craft_id) : undefined;

    const traitHits: any[] = [];
    const craftBonusDetails: any[] = [];
    let multiplier: number;
    let flatBonus: number;
    let personalBonusUsed: number;

    if (p.max_bond && !p.bond_switch2) {
      multiplier = 0;
      flatBonus = 0;
      personalBonusUsed = p.personal_bonus;
    } else {
      multiplier = calculateMemberMultiplier({
        servantTraits: traits,
        position: p.position,
        personalBonus: p.personal_bonus,
        playerCrafts,
        maxBondCount,
        activityBonus,
        auraBonus,
        supportCraft,
        supportSecondCraft,
        supportInFront,
        craftView,
      });
      flatBonus = craftView.flatBonus(ctx.servant_mask(p.servant_id, p.stage));
      personalBonusUsed = p.personal_bonus;
      for (const craftItem of effectCrafts) {
        if (craftItem.bonus_type === "trait") {
          const matchedGroups: string[][] = [];
          for (const g of craftItem.trigger_traits) {
            if (matchTraitGroup(traits, g)) matchedGroups.push([...g]);
          }
          if (matchedGroups.length === 0) continue;
          for (const g of matchedGroups) for (const t of g) traitCoverage.add(t);
          traitHits.push({
            craftId: craftItem.id,
            craftName: craftItem.name,
            groups: matchedGroups,
          });
          if (Number(craftItem.bonus_value || 0) > 0) {
            craftBonusDetails.push({
              craftId: craftItem.id,
              craftName: craftItem.name,
              type: "trait",
              value: Number(craftItem.bonus_value || 0),
              groups: matchedGroups,
            });
          }
          if (Number(craftItem.flat_bonus || 0) > 0) {
            craftBonusDetails.push({
              craftId: craftItem.id,
              craftName: craftItem.name,
              type: "flat",
              value: Number(craftItem.flat_bonus || 0),
            });
          }
        } else if (craftItem.bonus_type === "universal" || craftItem.bonus_type === "support_only") {
          if (Number(craftItem.bonus_value || 0) > 0) {
            craftBonusDetails.push({
              craftId: craftItem.id,
              craftName: craftItem.name,
              type: "universal",
              value: Number(craftItem.bonus_value || 0),
            });
          }
          if (Number(craftItem.flat_bonus || 0) > 0) {
            craftBonusDetails.push({
              craftId: craftItem.id,
              craftName: craftItem.name,
              type: "flat",
              value: Number(craftItem.flat_bonus || 0),
            });
          }
        }
      }
      for (const supportItem of [supportCraft, supportSecondCraft]) {
        if (!supportItem) continue;
        if (Number(supportItem.support_bonus || 0) > 0) {
          craftBonusDetails.push({
            craftId: supportItem.id,
            craftName: supportItem.name,
            type: "support",
            value: Number(supportItem.support_bonus || 0),
          });
        }
      }
    }

    totalMultiplier += multiplier;
    totalFlatBonus += flatBonus;
    members.push({
      position: p.position,
      servantId: p.servant_id,
      name: servant.name,
      stage: p.stage,
      isSupport: false,
      isFixed: p.fixed,
      isMaxBond: p.max_bond,
      isCrown: p.is_crown,
      craftId: p.craft_id,
      craftName: craft ? craft.name : "",
      craftType: craft && craft.is_bond_ce ? "bond" : "other",
      secondCraftId: p.second_craft_id,
      secondCraftName: secondCraft ? secondCraft.name : "",
      secondCraftType: secondCraft && secondCraft.is_bond_ce ? "bond" : "other",
      traitHits,
      craftBonusDetails,
      bonusDetail: {
        frontlineBonus: frontlineBonus(p.position, supportInFront),
        universalCraftBonus: universalBonus(effectCrafts),
        supportCraftBonus: supportCraftsBonus(supportCraft, supportSecondCraft),
        traitCraftBonus: craftView.traitBonus(traitMaskOf(traits)),
        flatCraftBonus: pyRound(flatBonus, 2),
        maxBondBonus,
        activityBonus,
        auraBonus: pyRound(auraBonus, 4),
        personalBonus: personalBonusUsed,
        totalMultiplier: pyRound(multiplier, 6),
        bondPoints: baseBond || flatBonus ? pyRound(multiplier * baseBond + flatBonus, 2) : 0,
      },
    });
  }

  let supportMember: any = null;
  if (team.support_position !== null && team.support_servant_id !== null) {
    const servant = ctx.servants.get(team.support_servant_id);
    const craft = team.support_craft_id !== null ? ctx.crafts.get(team.support_craft_id) : undefined;
    const secondCraft =
      team.support_second_craft_id !== null ? ctx.crafts.get(team.support_second_craft_id) : undefined;
    supportMember = {
      position: team.support_position,
      servantId: team.support_servant_id,
      name: servant ? servant.name : "",
      stage: "fourth",
      isSupport: true,
      isFixed: false,
      isMaxBond: false,
      isCrown: team.crown_positions.has(team.support_position),
      craftId: team.support_craft_id,
      craftName: craft ? craft.name : "",
      craftType: craft && craft.is_bond_ce ? "bond" : "other",
      secondCraftId: team.support_second_craft_id,
      secondCraftName: secondCraft ? secondCraft.name : "",
      secondCraftType: secondCraft && secondCraft.is_bond_ce ? "bond" : "other",
      traitHits: [],
      craftBonusDetails: [],
      bonusDetail: {
        frontlineBonus: 0,
        universalCraftBonus: 0,
        supportCraftBonus: 0,
        traitCraftBonus: 0,
        flatCraftBonus: 0,
        maxBondBonus: 0,
        activityBonus: 0,
        auraBonus: 0,
        personalBonus: 0,
        totalMultiplier: 0,
        bondPoints: 0,
      },
    };
  }

  const allMembers = supportMember ? [...members, supportMember] : [...members];
  const posOrder = new Map<string, number>(POSITIONS.map((pos, i) => [pos, i]));
  allMembers.sort((a, b) => (posOrder.get(a.position) ?? 99) - (posOrder.get(b.position) ?? 99));

  return {
    totalMultiplier: pyRound(totalMultiplier, 6),
    totalFlatBonus: pyRound(totalFlatBonus, 2),
    costUsed: teamCost(ctx, team),
    baseBond,
    totalBondPoints:
      baseBond || totalFlatBonus ? pyRound(totalMultiplier * baseBond + totalFlatBonus, 2) : 0,
    team: allMembers,
    maxBondStats: { count: maxBondCount, totalBonus: pyRound(maxBondBonus, 4) },
    traitCoverage: sortedStrings(traitCoverage),
  };
}
