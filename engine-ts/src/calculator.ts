// P2 求值层（第一批）：数据上下文 + 特性掩码 + 特性收益表
// 逐条对齐 python-engine/engine/calculator.py 的 1~425 行与 TraitBenefitTable。
import { STAGES } from "./constants.ts";
import { allRows, getMeta, openDatabase } from "./database.ts";

// ---------------------------------------------------------------------------
// 特性匹配加速：位掩码（JS 用 BigInt —— 特性数量会超过 53 位）
// ---------------------------------------------------------------------------
const TRAIT_BITS = new Map<string, bigint>();

export function traitBit(name: string): bigint {
  let bit = TRAIT_BITS.get(name);
  if (bit === undefined) {
    bit = 1n << BigInt(TRAIT_BITS.size);
    TRAIT_BITS.set(name, bit);
  }
  return bit;
}

export function traitMaskOf(traits: Iterable<string>): bigint {
  let mask = 0n;
  for (const name of traits) mask |= traitBit(name);
  return mask;
}

export function traitGroupMasks(groups: Iterable<Iterable<string>>): bigint[] {
  const out: bigint[] = [];
  for (const g of groups) out.push(traitMaskOf(g));
  return out;
}

// ---------------------------------------------------------------------------
// 运行时数据上下文
// ---------------------------------------------------------------------------
export class ServantInfo {
  id: number;
  name: string;
  servant_class: string;
  cost: number;
  rarity: number;
  traits: Record<string, Set<string>> = {};
  private traitMasks = new Map<string, bigint>();

  constructor(init: { id: number; name: string; servant_class: string; cost: number; rarity: number }) {
    this.id = init.id;
    this.name = init.name;
    this.servant_class = init.servant_class;
    this.cost = init.cost;
    this.rarity = init.rarity;
  }

  /** 指定阶段/灵衣的特性掩码（阶段不存在 = 0） */
  mask_for(stage: string): bigint {
    let mask = this.traitMasks.get(stage);
    if (mask === undefined) {
      mask = traitMaskOf(this.traits[stage] ?? []);
      this.traitMasks.set(stage, mask);
    }
    return mask;
  }
}

export class CraftInfo {
  id: number;
  name: string;
  cost: number;
  rarity: number;
  bonus_type: string | null;
  bonus_value: number;
  support_bonus: number;
  trigger_traits: string[][];
  is_bond_ce: boolean;
  detail: string;
  is_event_limited: boolean;
  flat_bonus: number;
  repeatable: boolean;
  is_custom: boolean;
  trigger_masks: bigint[];

  constructor(init: {
    id: number;
    name: string;
    cost: number;
    rarity: number;
    bonus_type: string | null;
    bonus_value: number;
    support_bonus: number;
    trigger_traits: string[][];
    is_bond_ce: boolean;
    detail?: string;
    is_event_limited?: boolean;
    flat_bonus?: number;
    repeatable?: boolean;
    is_custom?: boolean;
  }) {
    this.id = init.id;
    this.name = init.name;
    this.cost = init.cost;
    this.rarity = init.rarity;
    this.bonus_type = init.bonus_type;
    this.bonus_value = init.bonus_value;
    this.support_bonus = init.support_bonus;
    this.trigger_traits = init.trigger_traits;
    this.is_bond_ce = init.is_bond_ce;
    this.detail = init.detail ?? "";
    this.is_event_limited = init.is_event_limited ?? false;
    this.flat_bonus = init.flat_bonus ?? 0;
    this.repeatable = init.repeatable ?? false;
    this.is_custom = init.is_custom ?? false;
    this.trigger_masks = traitGroupMasks(this.trigger_traits ?? []);
  }
}

export class DataContext {
  servants: Map<number, ServantInfo>;
  crafts: Map<number, CraftInfo>;
  unavailable_servant_ids: Set<number>;

  constructor(init: {
    servants?: Map<number, ServantInfo>;
    crafts?: Map<number, CraftInfo>;
    unavailable_servant_ids?: Set<number>;
  } = {}) {
    this.servants = init.servants ?? new Map();
    this.crafts = init.crafts ?? new Map();
    this.unavailable_servant_ids = init.unavailable_servant_ids ?? new Set();
  }

  servant_traits(servantId: number, stage: string): Set<string> {
    return this.servants.get(servantId)?.traits[stage] ?? new Set();
  }

  servant_mask(servantId: number, stage: string): bigint {
    const s = this.servants.get(servantId);
    return s ? s.mask_for(stage) : 0n;
  }

  craft(id: number): CraftInfo | undefined {
    return this.crafts.get(id);
  }
}

// ---------------------------------------------------------------------------
// 载入
// ---------------------------------------------------------------------------
function loadAllServants(db: any): Map<number, ServantInfo> {
  const out = new Map<number, ServantInfo>();
  for (const r of allRows(db, "SELECT id, name, class, cost, rarity FROM servants")) {
    const id = Number(r["id"]);
    out.set(
      id,
      new ServantInfo({
        id,
        name: String(r["name"]),
        servant_class: String(r["class"]),
        cost: Number(r["cost"] ?? 0),
        rarity: Number(r["rarity"] ?? 0),
      }),
    );
  }
  return out;
}

function loadAllTraits(db: any, region = "jp"): Map<number, Record<string, Set<string>>> {
  const useCn = region === "cn";
  const stageTable = useCn ? "servant_stage_traits_cn" : "servant_stage_traits";
  const costumeTable = useCn ? "servant_costume_traits_cn" : "servant_costume_traits";
  const out = new Map<number, Record<string, Set<string>>>();
  const push = (sid: number, key: string, trait: string) => {
    let rec = out.get(sid);
    if (rec === undefined) {
      rec = {};
      out.set(sid, rec);
    }
    let set = rec[key];
    if (set === undefined) {
      set = new Set();
      rec[key] = set;
    }
    set.add(trait);
  };

  for (const r of allRows(
    db,
    `SELECT servant_id, stage, trait FROM ${stageTable} WHERE trait <> 'unknown'`,
  )) {
    push(Number(r["servant_id"]), String(r["stage"]), String(r["trait"]));
  }
  for (const r of allRows(
    db,
    `SELECT servant_id, costume_id, trait FROM ${costumeTable} WHERE trait <> 'unknown'`,
  )) {
    push(Number(r["servant_id"]), `costume_${Number(r["costume_id"])}`, String(r["trait"]));
  }
  if (useCn) {
    for (const r of allRows(
      db,
      "SELECT servant_id, stage, trait FROM servant_stage_traits WHERE trait <> 'unknown'",
    )) {
      const sid = Number(r["servant_id"]);
      const rec = out.get(sid);
      if (rec === undefined || Object.keys(rec).length === 0) {
        push(sid, String(r["stage"]), String(r["trait"]));
      }
    }
    for (const r of allRows(
      db,
      "SELECT servant_id, costume_id, trait FROM servant_costume_traits WHERE trait <> 'unknown'",
    )) {
      const sid = Number(r["servant_id"]);
      const key = `costume_${Number(r["costume_id"])}`;
      const rec = out.get(sid);
      if (rec === undefined || rec[key] === undefined || rec[key].size === 0) {
        push(sid, key, String(r["trait"]));
      }
    }
  }
  return out;
}

export function cleanTriggerGroups(groups: any): string[][] {
  const cleaned: string[][] = [];
  for (const group of groups ?? []) {
    if (!Array.isArray(group)) continue;
    const names = group
      .filter((x: any) => x && String(x) !== "unknown")
      .map((x: any) => String(x));
    if (names.length > 0) cleaned.push(names);
  }
  return cleaned;
}

function customCraftDetailText(
  name: string,
  isBond: boolean,
  percent: number,
  flat: number,
  trigger: string[][],
): string {
  if (!isBond) return `自定义其他礼装：${name}`;
  const parts: string[] = [];
  if (percent > 0) parts.push(`牵绊加成 ${formatG(percent * 100)}%`);
  if (flat > 0) parts.push(`最终牵绊固定 +${formatG(flat)}`);
  if (parts.length === 0) return `自定义牵绊礼装：${name}`;
  let cond = "";
  if (trigger.length > 0) {
    cond = "（" + trigger.map((g) => g.join("且")).join(" 或 ") + "）";
  }
  return "关卡通关时" + parts.join("、") + cond;
}

/** 对齐 Python f"{x:g}" 的最简实现（去掉多余的 0 与小数点） */
function formatG(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toPrecision(6)));
}

function loadAllCrafts(db: any): Map<number, CraftInfo> {
  const out = new Map<number, CraftInfo>();
  for (const r of allRows(db, "SELECT * FROM crafts")) {
    const trigger = cleanTriggerGroups(
      r["trigger_traits_json"] ? JSON.parse(r["trigger_traits_json"]) : [],
    );
    out.set(
      Number(r["id"]),
      new CraftInfo({
        id: Number(r["id"]),
        name: String(r["name"]),
        cost: Number(r["cost"] ?? 0),
        rarity: Number(r["rarity"] ?? 0),
        bonus_type: r["bonus_type"] ?? null,
        bonus_value: Number(r["bonus_value"] ?? 0),
        support_bonus: Number(r["support_bonus"] ?? 0),
        trigger_traits: trigger,
        is_bond_ce: Boolean(r["is_bond_ce"]),
        detail: String(r["detail"] ?? ""),
        is_event_limited: Boolean(r["is_event_limited"]),
      }),
    );
  }
  // 自定义礼装（用户数据）
  let customs: any[] = [];
  try {
    customs = allRows(
      db,
      "SELECT id, name, craft_type, cost, rarity, percent_bonus, flat_bonus, " +
        "condition_groups_json, repeatable, enabled FROM custom_crafts WHERE enabled = 1",
    );
  } catch {
    customs = [];
  }
  for (const r of customs) {
    const cid = Number(r["id"]);
    const isBond = r["craft_type"] === "bond";
    const trigger = cleanTriggerGroups(
      r["condition_groups_json"] ? JSON.parse(r["condition_groups_json"]) : [],
    );
    const percent = Number(r["percent_bonus"] ?? 0) / 100;
    const flat = Number(r["flat_bonus"] ?? 0);
    let bonusType: string | null = null;
    if (isBond) {
      if (trigger.length > 0) bonusType = "trait";
      else if (percent > 0 || flat > 0) bonusType = "universal";
    }
    out.set(
      cid,
      new CraftInfo({
        id: cid,
        name: String(r["name"]),
        cost: Number(r["cost"] ?? 0),
        rarity: Number(r["rarity"] ?? 0),
        bonus_type: bonusType,
        bonus_value: percent,
        support_bonus: 0,
        trigger_traits: trigger,
        is_bond_ce: isBond,
        detail: customCraftDetailText(String(r["name"]), isBond, percent, flat, trigger),
        is_event_limited: false,
        flat_bonus: flat,
        repeatable: Boolean(r["repeatable"]),
        is_custom: true,
      }),
    );
  }
  return out;
}

function loadUnavailableServantIds(db: any, region = "jp"): Set<number> {
  if (region !== "cn") return new Set();
  try {
    const raw = getMeta(db, "cn_unavailable_servant_ids") ?? "[]";
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return new Set();
    return new Set(data.filter((x: any) => x !== null && x !== undefined).map((x: any) => Number(x)));
  } catch {
    return new Set();
  }
}

type Synthetic = [number, number, string];

const SYNTHETIC_OTHER: Synthetic[] = [
  [0, 0, "无礼装"],
  [-1, 1, "其他礼装(1★)"],
  [-2, 3, "其他礼装(2★)"],
  [-3, 5, "其他礼装(3★)"],
  [-4, 9, "其他礼装(4★)"],
  [-5, 12, "其他礼装(5★)"],
];

export async function loadContext(dbPath: string, region = "jp"): Promise<DataContext> {
  const db = await openDatabase(dbPath);
  try {
    const servants = loadAllServants(db);
    const traits = loadAllTraits(db, region);
    for (const [sid, info] of servants) info.traits = traits.get(sid) ?? {};
    const crafts = loadAllCrafts(db);
    const unavailable = loadUnavailableServantIds(db, region);

    for (const [cid, cost, name] of SYNTHETIC_OTHER) {
      crafts.set(
        cid,
        new CraftInfo({
          id: cid,
          name,
          cost,
          rarity: Math.abs(cid),
          bonus_type: null,
          bonus_value: 0,
          support_bonus: 0,
          trigger_traits: [],
          is_bond_ce: false,
        }),
      );
    }
    crafts.set(
      -10,
      new CraftInfo({
        id: -10,
        name: "通用5%",
        cost: 12,
        rarity: 5,
        bonus_type: "universal",
        bonus_value: 0.05,
        support_bonus: 0,
        trigger_traits: [],
        is_bond_ce: true,
        detail: "关卡通关时获得的牵绊点数提升5%（可重复布置）",
      }),
    );
    crafts.set(
      -20,
      new CraftInfo({
        id: -20,
        name: "通用英灵肖像",
        cost: 5,
        rarity: 4,
        bonus_type: "universal",
        bonus_value: 0,
        support_bonus: 0,
        trigger_traits: [],
        is_bond_ce: true,
        detail: "关卡通关时获得的牵绊值固定 +50（无条件）",
        flat_bonus: 50,
      }),
    );
    crafts.set(
      -21,
      new CraftInfo({
        id: -21,
        name: "通用英灵逢魔",
        cost: 9,
        rarity: 4,
        bonus_type: "trait",
        bonus_value: 0.1,
        support_bonus: 0,
        trigger_traits: [["FSNServant"]],
        is_bond_ce: true,
        detail: "关卡通关时获得的〔Fate/stay night从者〕牵绊值提升10%",
      }),
    );
    crafts.set(
      -22,
      new CraftInfo({
        id: -22,
        name: "通用英灵极点",
        cost: 9,
        rarity: 4,
        bonus_type: "universal",
        bonus_value: 0.02,
        support_bonus: 0,
        trigger_traits: [],
        is_bond_ce: true,
        detail: "关卡通关时获得的牵绊值提升2%（英灵极点系列通用）",
      }),
    );
    return new DataContext({ servants, crafts, unavailable_servant_ids: unavailable });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 特性收益表（对齐 TraitBenefitTable）
// ---------------------------------------------------------------------------
export class TraitBenefitTable {
  ctx: DataContext;
  private values = new Map<number, number>();
  private masks = new Map<number, bigint[]>();
  private matchCache = new Map<number, bigint[]>();

  constructor(ctx: DataContext) {
    this.ctx = ctx;
  }

  craftValue(craftId: number): number {
    let v = this.values.get(craftId);
    if (v === undefined) {
      v = Number(this.ctx.crafts.get(craftId)?.bonus_value ?? 0);
      this.values.set(craftId, v);
    }
    return v;
  }

  stageMasks(servantId: number): bigint[] {
    let cached = this.masks.get(servantId);
    if (cached === undefined) {
      const info = this.ctx.servants.get(servantId);
      if (!info || Object.keys(info.traits).length === 0) cached = [0n];
      else cached = Object.keys(info.traits).map((stage) => info.mask_for(stage));
      this.masks.set(servantId, cached);
    }
    return cached;
  }

  matches(servantId: number, craftId: number): bigint[] {
    const key = servantId * 16777216 + (craftId + 16777216);
    let cached = this.matchCache.get(key);
    if (cached !== undefined) return cached;
    const craft = this.ctx.crafts.get(craftId);
    if (!craft || craft.trigger_masks.length === 0) {
      cached = [];
    } else {
      cached = this.stageMasks(servantId).filter((mask) =>
        craft.trigger_masks.some((gm) => (mask & gm) === gm),
      );
    }
    this.matchCache.set(key, cached);
    return cached;
  }

  canTrigger(servantId: number, craftId: number): boolean {
    return this.matches(servantId, craftId).length > 0;
  }

  topSum(servantId: number, craftIds: number[], limit = 5): number {
    if (limit <= 0) return 0;
    const values: number[] = [];
    for (const cid of craftIds) {
      if (this.canTrigger(servantId, cid)) values.push(this.craftValue(cid));
    }
    if (values.length === 0) return 0;
    if (values.length <= limit) return values.reduce((a, b) => a + b, 0);
    values.sort((a, b) => b - a);
    return values.slice(0, limit).reduce((a, b) => a + b, 0);
  }
}

export function traitBenefitTable(ctx: DataContext): TraitBenefitTable {
  const key = "_traitTable";
  const anyCtx = ctx as any;
  if (!anyCtx[key]) anyCtx[key] = new TraitBenefitTable(ctx);
  return anyCtx[key];
}


/**
 * 从验证串快照重建 DataContext（对齐 verification.py::load_context_from_snapshot）。
 * 注意：快照里的特性是**裁剪过**的（只保留 Box 内的人，Box 外全空），
 * 所以用它跑出来的分数与"用完整库跑"本来就不同 —— 对拍时必须用同一份快照。
 */
export function loadContextFromSnapshot(snapshot: any): DataContext {
  const ctx = new DataContext();
  for (const raw of snapshot?.servants ?? []) {
    const sid = Number(raw["id"]);
    const traits: Record<string, Set<string>> = {};
    for (const [stage, names] of Object.entries(raw["traits"] ?? {})) {
      traits[String(stage)] = new Set((names as any[]).map((t) => String(t)));
    }
    ctx.servants.set(
      sid,
      new ServantInfo({
        id: sid,
        name: String(raw["name"] ?? ""),
        servant_class: String(raw["class"] ?? ""),
        cost: Number(raw["cost"] ?? 0),
        rarity: Number(raw["rarity"] ?? 0),
      }),
    );
    ctx.servants.get(sid)!.traits = traits;
  }
  for (const raw of snapshot?.crafts ?? []) {
    const cid = Number(raw["id"]);
    ctx.crafts.set(
      cid,
      new CraftInfo({
        id: cid,
        name: String(raw["name"] ?? ""),
        cost: Number(raw["cost"] ?? 0),
        rarity: Number(raw["rarity"] ?? 0),
        bonus_type: raw["bonusType"] ?? null,
        bonus_value: Number(raw["bonusValue"] ?? 0),
        support_bonus: Number(raw["supportBonus"] ?? 0),
        trigger_traits: ((raw["triggerTraits"] ?? []) as any[]).map((g) =>
          (g as any[]).map((x) => String(x)),
        ),
        is_bond_ce: Boolean(raw["isBondCe"]),
        detail: String(raw["detail"] ?? ""),
        is_event_limited: Boolean(raw["isEventLimited"]),
        flat_bonus: Number(raw["flatBonus"] ?? 0),
        repeatable: Boolean(raw["repeatable"]),
        is_custom: Boolean(raw["isCustom"]),
      }),
    );
  }
  return ctx;
}

export { STAGES };
