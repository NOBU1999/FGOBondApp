"use strict";
/**
 * 牵绊计算的**纯函数层**（不碰 DOM、不碰 Vue、不碰 IPC）。
 *
 * 为什么单独一个文件：这部分是"按引擎同一口径重算一位从者的加成 / 倍率 / 牵绊"，
 * 只用在同分替补这种"引擎没返回个体数值"的场合。抽出来才能拿引擎的现成结果
 * 逐位对拍（探针 `.temp/probe-bond-math-parity.cjs`），也能被渲染层与测试共用一份。
 *
 * 口径抄自 python-engine/engine/calculator.py：
 *   multiplier = (1 + 前排系数) × (1 + 通用 + 助战 + 特性 + 满绊25%×人数 + 活动 + 光环 + 个人)
 *   bondPoints = multiplier × 基础牵绊 + 固定值
 *   满绊且"自身参与收益"关闭（maxBond && !switch2）⇒ 该位倍率直接记 0
 *   形态选择（_stage_target_for）：特性收益最大 → 平手优先再临阶段取更高 → 只有再临达不到才用灵衣
 */
(function (global) {
  const STAGES = ["initial", "first", "second", "third", "fourth"];
  const FRONT = new Set(["front_left", "front_middle", "front_right"]);

  /** 礼装的触发条件组：支持 `triggerTraits`（[[a,b],[c]]）、`triggerTraitsJson`、`conditionGroups` 三种写法 */
  function triggerGroups(craft) {
    if (!craft) return [];
    let raw = craft.triggerTraits;
    if (raw === undefined) raw = craft.triggerTraitsJson;
    if (raw === undefined) raw = craft.conditionGroups;
    const normalize = (parsed) => parsed
      .map((g) => (Array.isArray(g) ? g : [g]))
      .filter((g) => g.length);
    if (Array.isArray(raw)) return normalize(raw);
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return normalize(parsed);
      } catch (_) {
        /* 坏 JSON 当作无条件 */
      }
    }
    return [];
  }

  /**
   * 把"库内礼装 / 自定义礼装 / 合成礼装"三种来源统一成同一个形状。
   * 字段名差异只在这里处理，别处一律用归一套。
   */
  function normCraft(craft) {
    if (!craft) return null;
    const bonusType = craft.bonusType || craft.bonus_type ||
      (triggerGroups(craft).length ? "trait" : "universal");
    const isBond = craft.isBondCe !== undefined
      ? !!craft.isBondCe
      : (craft.is_bond_ce !== undefined ? !!craft.is_bond_ce : craft.craftType !== "other");
    return {
      id: craft.id,
      name: craft.name,
      bonusType,
      bonusValue: Number(craft.bonusValue !== undefined ? craft.bonusValue
        : (craft.percentBonus !== undefined ? craft.percentBonus : craft.bonus_value)) || 0,
      supportBonus: Number(craft.supportBonus !== undefined ? craft.supportBonus : craft.support_bonus) || 0,
      flatBonus: Number(craft.flatBonus !== undefined ? craft.flatBonus : craft.flat_bonus) || 0,
      isBond,
      groups: triggerGroups(craft),
    };
  }

  function isTraitCraft(craft) {
    const c = craft && craft.groups ? craft : normCraft(craft);
    return !!c && c.isBond && c.bonusType === "trait";
  }

  function isUniversal(craft) {
    const c = craft && craft.groups ? craft : normCraft(craft);
    return !!c && (c.bonusType === "universal" || c.bonusType === "support_only");
  }

  /**
   * 一名从者在给定特性集合下能吃到的**特性礼装**加成总额。
   * 一张礼装只要"任意一组条件全部满足"就算一次（同一张最多算一次），与引擎一致。
   */
  function traitBonus(traits, crafts) {
    const set = traits instanceof Set ? traits : new Set(traits || []);
    let total = 0;
    for (const raw of crafts || []) {
      const craft = raw && raw.groups ? raw : normCraft(raw);
      if (!craft || !craft.isBond || craft.bonusType !== "trait" || !craft.groups.length) continue;
      if (craft.groups.some((g) => g.every((t) => set.has(t)))) total += craft.bonusValue;
    }
    return total;
  }

  /** 固定数值加成（只来自 flatBonus > 0 的礼装，判据同 flat_bonus_for_mask） */
  function flatBonus(traits, crafts) {
    const set = traits instanceof Set ? traits : new Set(traits || []);
    let total = 0;
    for (const raw of crafts || []) {
      const craft = raw && raw.groups ? raw : normCraft(raw);
      if (!craft || !craft.isBond || craft.flatBonus <= 0) continue;
      if (!craft.groups.length) {
        // 无条件的固定值：只有 universal/support_only 才吃（引擎里 trait 类型必须带条件）
        if (craft.bonusType === "universal" || craft.bonusType === "support_only") total += craft.flatBonus;
        continue;
      }
      if (craft.groups.some((g) => g.every((t) => set.has(t)))) total += craft.flatBonus;
    }
    return total;
  }

  /** 通用加成（含助战位并入的那部分礼装；engine universal_bonus 同口径） */
  function universalBonus(crafts) {
    let total = 0;
    for (const raw of crafts || []) {
      const craft = raw && raw.groups ? raw : normCraft(raw);
      if (!craft || !craft.isBond) continue;
      if (craft.bonusType === "universal" || craft.bonusType === "support_only") total += craft.bonusValue;
    }
    return total;
  }

  /** 单张助战礼装的"助战位专属"加成（engine support_craft_bonus 同口径） */
  function supportCraftBonus(craft) {
    const c = normCraft(craft);
    if (!c) return 0;
    if (c.supportBonus > 0) return c.supportBonus;
    if (c.bonusType === "support_only") return c.bonusValue;
    return 0;
  }

  /** 该从者的所有形态键（先再临 0~4，再灵衣按 id 升序） */
  function formKeys(forms) {
    const asc = STAGES.filter((k) => forms && forms[k]);
    const costumes = Object.keys(forms || {})
      .filter((k) => k.indexOf("costume_") === 0)
      .sort((a, b) => Number(a.split("_")[1]) - Number(b.split("_")[1]));
    return asc.concat(costumes);
  }

  /**
   * 按引擎 `_stage_target_for` 的口径挑形态。
   * @param forms { 形态键: [特性...] }
   * @param traitCrafts 本队用到的特性礼装
   * @returns 形态键；无法判断时返回 null（调用方保留原形态）
   */
  function bestForm(forms, traitCrafts) {
    const keys = formKeys(forms);
    if (!keys.length) return null;
    const asc = STAGES.filter((k) => forms[k]);
    const costumes = keys.filter((k) => k.indexOf("costume_") === 0);
    if (!(traitCrafts || []).length) {
      // 没有特性礼装：一律最高再临阶段；没有再临数据才退到灵衣
      return asc.length ? asc[asc.length - 1] : costumes[0];
    }
    const score = (k) => traitBonus(forms[k], traitCrafts);
    let best = -Infinity;
    keys.forEach((k) => {
      const v = score(k);
      if (v > best) best = v;
    });
    const bestAsc = asc.filter((k) => score(k) === best);
    if (bestAsc.length) return bestAsc[bestAsc.length - 1]; // 平手取更高再临
    const bestCostume = costumes.filter((k) => score(k) === best);
    return bestCostume.length ? bestCostume[0] : null;
  }

  /** 前排系数（与引擎 frontline_bonus 一致：前排 +20%，助战在前排时后排也算？） */
  function frontlineBonus(position, supportInFront) {
    // 引擎：front_left/front_middle/front_right 得 0.2；其余 0。
    // supportInFront 参数保留（引擎里只影响"前排是否含助战"的判定，位置本身决定加成）。
    void supportInFront;
    return FRONT.has(String(position || "")) ? 0.2 : 0;
  }

  /** 个人倍率：与引擎 calculate_member_multiplier 同构 */
  function memberMultiplier(o) {
    const front = Number(o.frontline || 0);
    const inner =
      Number(o.universal || 0) +
      Number(o.support || 0) +
      Number(o.trait || 0) +
      Number(o.maxBond || 0) +
      Number(o.activity || 0) +
      Number(o.aura || 0) +
      Number(o.personal || 0);
    return (1 + front) * (1 + inner);
  }

  /** 牵绊点数：与引擎一致（multiplier × 基础 + 固定值；都为 0 时记 0） */
  function bondPoints(multiplier, baseBond, flat) {
    const base = Number(baseBond || 0);
    const f = Number(flat || 0);
    if (!base && !f) return 0;
    return Math.round((Number(multiplier) * base + f) * 100) / 100;
  }

  global.BondMath = {
    STAGES,
    triggerGroups,
    normCraft,
    isTraitCraft,
    isUniversal,
    traitBonus,
    flatBonus,
    universalBonus,
    supportCraftBonus,
    formKeys,
    bestForm,
    frontlineBonus,
    memberMultiplier,
    bondPoints,
  };
})(typeof window !== "undefined" ? window : globalThis);
