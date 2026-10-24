// P3b-2：布局准备（对齐 search.py 的 prepare_blueprint / _choose_support_position）
import { CLASS_GROUPS, POSITIONS, type BoxServant, type CalculationRequest } from "./models.ts";
import { SupportConfig } from "./models.ts";
import { type DataContext } from "./calculator.ts";
import { PlacedMember } from "./team.ts";
import {
  Blueprint,
  CraftSlot,
  PlayerSlot,
  boxMap,
  isOumaCraft,
  servantInClassGroup,
} from "./teamBuild.ts";

export function chooseSupportPosition(
  req: CalculationRequest,
  playerSlots: PlayerSlot[],
): string {
  if (req.support && req.support.position) return req.support.position;
  const occupied = new Set(playerSlots.map((s) => s.position));
  if (!occupied.has("back_right")) return "back_right";
  for (const pos of POSITIONS) if (!occupied.has(pos)) return pos;
  return POSITIONS[POSITIONS.length - 1];
}

export function prepareBlueprint(req: CalculationRequest, ctx: DataContext): Blueprint {
  if (req.class_group && !(req.class_group in CLASS_GROUPS)) {
    throw new Error(`未知职阶筛选: ${req.class_group}`);
  }
  const box: Map<number, BoxServant> = boxMap(req);
  const rawSlots = new Map<string, PlayerSlot>();
  for (const pos of POSITIONS) {
    rawSlots.set(
      pos,
      new PlayerSlot({ position: pos, is_crown: req.crown_positions.has(pos) }),
    );
  }

  const usedPositions = new Set<string>();
  const fixedServantIds = new Set<number>();
  const fixedPlayerMembers: PlacedMember[] = [];

  const fixedServants = [...req.fixed_servants];
  const unspecified = fixedServants.filter((fs) => !fs.position);
  const specified = fixedServants.filter((fs) => fs.position);

  const checkServantClass = (sid: number): void => {
    if (!servantInClassGroup(ctx, sid, req.class_group)) {
      const name = ctx.servants.get(sid)?.name ?? sid;
      throw new Error(`固定从者 ${name} 不属于当前职阶筛选，请先调整职阶或移除该从者`);
    }
  };

  for (const fs of specified) {
    if (fixedServantIds.has(fs.servant_id)) throw new Error(`固定从者重复: ${fs.servant_id}`);
    if (!POSITIONS.includes(fs.position as any)) throw new Error(`未知位置: ${fs.position}`);
    if (usedPositions.has(fs.position!)) throw new Error(`固定从者位置冲突: ${fs.position}`);
    checkServantClass(fs.servant_id);
    usedPositions.add(fs.position!);
    fixedServantIds.add(fs.servant_id);
    rawSlots.get(fs.position!)!.fixed_servant_id = fs.servant_id;
  }

  for (const pos of POSITIONS) {
    if (!usedPositions.has(pos) && unspecified.length > 0) {
      const fs = unspecified.shift()!;
      if (fixedServantIds.has(fs.servant_id)) throw new Error(`固定从者重复: ${fs.servant_id}`);
      checkServantClass(fs.servant_id);
      usedPositions.add(pos);
      fixedServantIds.add(fs.servant_id);
      rawSlots.get(pos)!.fixed_servant_id = fs.servant_id;
    }
  }
  if (unspecified.length > 0) throw new Error("固定从者位置不足");

  const usedCraftSlots = new Set<string>();
  const fixedBondIds: number[] = [];
  const fixedOtherIds: number[] = [];
  for (const fc of req.fixed_crafts) {
    const slotNo = fc.slot;
    if (!POSITIONS.includes(fc.position as any)) throw new Error(`未知礼装位置: ${fc.position}`);
    if (slotNo !== 0 && slotNo !== 1) throw new Error(`未知礼装槽位: ${slotNo}`);
    const slot = rawSlots.get(fc.position)!;
    if (slotNo === 1 && !slot.is_crown) {
      throw new Error(`位置 ${fc.position} 未设为冠位从者，不能有第二礼装`);
    }
    const craft = ctx.crafts.get(fc.craft_id);
    if (craft === undefined) throw new Error(`礼装不存在: ${fc.craft_id}`);
    if (fc.type === "bond" && isOumaCraft(ctx, fc.craft_id)) continue;
    const key = `${fc.position}#${slotNo}`;
    if (usedCraftSlots.has(key)) {
      throw new Error(`固定礼装位置冲突: ${fc.position} 槽位 ${slotNo}`);
    }
    usedCraftSlots.add(key);
    if (slotNo === 0) {
      slot.fixed_craft_id = fc.craft_id;
      slot.fixed_craft_type = fc.type;
    } else {
      slot.fixed_second_craft_id = fc.craft_id;
      slot.fixed_second_craft_type = fc.type;
    }
    if (fc.type === "bond") fixedBondIds.push(fc.craft_id);
    else fixedOtherIds.push(fc.craft_id);
  }

  const manualSupport = new SupportConfig({
    servant_id: req.support?.servant_id ?? null,
    craft_id: req.support?.craft_id ?? null,
    second_craft_id: req.support?.second_craft_id ?? null,
    position: req.support?.position ?? null,
  });
  if (manualSupport.craft_id !== null && isOumaCraft(ctx, manualSupport.craft_id)) {
    manualSupport.craft_id = null;
  }
  if (
    manualSupport.second_craft_id !== null &&
    isOumaCraft(ctx, manualSupport.second_craft_id)
  ) {
    manualSupport.second_craft_id = null;
  }
  if (
    manualSupport.servant_id !== null &&
    !servantInClassGroup(ctx, manualSupport.servant_id, req.class_group)
  ) {
    const info = ctx.servants.get(manualSupport.servant_id);
    throw new Error(
      `助战从者 ${info ? info.name : manualSupport.servant_id} 不属于当前职阶筛选，请先调整职阶`,
    );
  }

  const playerSlotsAll = [...rawSlots.values()];
  const supportPosition = chooseSupportPosition(req, playerSlotsAll);
  const supportSlot = rawSlots.get(supportPosition)!;
  if (supportSlot.fixed_servant_id !== null) {
    throw new Error(`助战位与固定从者冲突: ${supportPosition}`);
  }
  if (supportSlot.fixed_craft_id !== null || supportSlot.fixed_second_craft_id !== null) {
    throw new Error(`助战位与固定礼装冲突: ${supportPosition}`);
  }

  const playerSlots = POSITIONS.filter((pos) => pos !== supportPosition).map(
    (pos) => rawSlots.get(pos)!,
  );

  const fixedStageByPosition = new Map<string, string>();
  for (const fs of req.fixed_servants) {
    if (fs.position && fs.stage) fixedStageByPosition.set(fs.position, fs.stage);
  }

  for (const slot of playerSlots) {
    if (slot.fixed_servant_id === null) continue;
    const bs = box.get(slot.fixed_servant_id);
    if (!bs) throw new Error(`固定从者不在 Box 中: ${slot.fixed_servant_id}`);
    const userStage = fixedStageByPosition.get(slot.position) ?? null;
    fixedPlayerMembers.push(
      new PlacedMember({
        position: slot.position,
        servant_id: slot.fixed_servant_id,
        stage: userStage ?? bs.stage,
        personal_bonus: bs.personal_bonus,
        aura_bonus: bs.aura_bonus,
        max_bond: bs.max_bond,
        bond_switch1: bs.bond_switch1,
        bond_switch2: bs.bond_switch2,
        craft_id: slot.fixed_craft_id,
        second_craft_id: slot.fixed_second_craft_id,
        is_crown: slot.is_crown,
        fixed: true,
        stage_locked: userStage !== null,
      }),
    );
  }

  const freeServantPositions = playerSlots
    .filter((s) => s.fixed_servant_id === null)
    .map((s) => s.position);

  const orderedSlots = [...playerSlots].sort((a, b) => {
    const ca = a.is_crown ? 0 : 1;
    const cb = b.is_crown ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return POSITIONS.indexOf(a.position as any) - POSITIONS.indexOf(b.position as any);
  });
  const playerCraftSlots: CraftSlot[] = [];
  for (const slot of orderedSlots) {
    playerCraftSlots.push(
      new CraftSlot({
        position: slot.position,
        index: 0,
        fixed_craft_id: slot.fixed_craft_id,
        fixed_craft_type: slot.fixed_craft_type,
      }),
    );
    if (slot.is_crown) {
      playerCraftSlots.push(
        new CraftSlot({
          position: slot.position,
          index: 1,
          fixed_craft_id: slot.fixed_second_craft_id,
          fixed_craft_type: slot.fixed_second_craft_type,
        }),
      );
    }
  }
  const freeBondPositions = playerCraftSlots
    .filter((cs) => cs.fixed_craft_id === null)
    .map((cs) => cs.position);

  return new Blueprint({
    support_position: supportPosition,
    support_servant_id: manualSupport.servant_id,
    support_craft_id: manualSupport.craft_id,
    support_second_craft_id: manualSupport.second_craft_id,
    player_slots: playerSlots,
    fixed_player_members: fixedPlayerMembers,
    free_servant_positions: freeServantPositions,
    player_craft_slots: playerCraftSlots,
    free_bond_positions: freeBondPositions,
    fixed_bond_craft_ids: fixedBondIds,
    fixed_other_craft_ids: fixedOtherIds,
    fixed_servant_ids: fixedServantIds,
    crown_positions: new Set(req.crown_positions),
  });
}
