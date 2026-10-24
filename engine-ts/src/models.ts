// P2：请求模型与 JSON 解析（逐条对齐旧实现的 models）
export const POSITIONS = [
  "front_left",
  "front_middle",
  "front_right",
  "back_left",
  "back_middle",
  "back_right",
] as const;
export type Position = (typeof POSITIONS)[number];

export const FRONT_POSITIONS = new Set<string>(["front_left", "front_middle", "front_right"]);

export const CLASS_GROUPS: Record<string, Set<string>> = {
  saber: new Set(["saber"]),
  archer: new Set(["archer"]),
  lancer: new Set(["lancer"]),
  rider: new Set(["rider"]),
  caster: new Set(["caster"]),
  assassin: new Set(["assassin"]),
  berserker: new Set(["berserker"]),
  ex1: new Set(["ruler", "avenger", "moonCancer", "shielder"]),
  ex2: new Set([
    "alterEgo",
    "foreigner",
    "pretender",
    "beast",
    "beastEresh",
    "unBeastOlgaMarie",
  ]),
  // 全EX = EX1 ∪ EX2：游戏里 Extra 是**一个**职阶，戴冠战按这个口径时两组都要算进来
  exall: new Set([
    "ruler",
    "avenger",
    "moonCancer",
    "shielder",
    "alterEgo",
    "foreigner",
    "pretender",
    "beast",
    "beastEresh",
    "unBeastOlgaMarie",
  ]),
};

export const STRATEGY_TOTAL_MAX = "total_max";
export const STRATEGY_TARGET_MAX = "target_max";
export const STRATEGY_BALANCED = "balanced";

export const SORT_MULTIPLIER = "multiplier";
export const SORT_POINTS = "points";
export const TARGET_SERVANT_KEY = "targetServantId";

export type AnyRec = Record<string, any>;

export class BoxServant {
  servant_id: number;
  stage: string;
  max_bond: boolean;
  bond_switch1: boolean;
  bond_switch2: boolean;
  personal_bonus: number;
  aura_bonus: number;
  name = "";
  servant_class = "";
  cost = 0;
  rarity = 0;
  traits = new Set<string>();

  constructor(init: Partial<BoxServant> & { servant_id: number }) {
    this.servant_id = init.servant_id;
    this.stage = init.stage ?? "fourth";
    this.max_bond = init.max_bond ?? false;
    this.bond_switch1 = init.bond_switch1 ?? false;
    this.bond_switch2 = init.bond_switch2 ?? false;
    this.personal_bonus = init.personal_bonus ?? 0;
    this.aura_bonus = init.aura_bonus ?? 0;
  }

  /** 开关一：是否参与全队满绊人数统计 */
  get count_in_team_bonus(): boolean {
    return this.max_bond && this.bond_switch1;
  }

  /** 该从者个人收益是否计入（满绊且未开开关二 → 0） */
  get count_personal_bond(): boolean {
    if (this.max_bond && !this.bond_switch2) return false;
    return true;
  }
}

export class FixedServant {
  servant_id: number;
  position: string | null;
  stage: string | null;
  constructor(init: { servant_id: number; position?: string | null; stage?: string | null }) {
    this.servant_id = init.servant_id;
    this.position = init.position ?? null;
    this.stage = init.stage ?? null;
  }
}

export class FixedCraft {
  position: string;
  craft_id: number;
  type: string;
  slot: number;
  constructor(init: { position: string; craft_id: number; type?: string; slot?: number }) {
    this.position = init.position;
    this.craft_id = init.craft_id;
    this.type = init.type ?? "bond";
    this.slot = init.slot ?? 0;
  }
}

export class SupportConfig {
  servant_id: number | null;
  craft_id: number | null;
  position: string | null;
  second_craft_id: number | null;
  constructor(init: Partial<SupportConfig> = {}) {
    this.servant_id = init.servant_id ?? null;
    this.craft_id = init.craft_id ?? null;
    this.position = init.position ?? null;
    this.second_craft_id = init.second_craft_id ?? null;
  }
}

export class CalculationRequest {
  box: BoxServant[] = [];
  fixed_servants: FixedServant[] = [];
  fixed_crafts: FixedCraft[] = [];
  support: SupportConfig | null = null;
  cost_limit = 114;
  strategy = STRATEGY_TOTAL_MAX;
  excluded_servant_ids = new Set<number>();
  excluded_craft_ids = new Set<number>();
  support_excluded_craft_ids = new Set<number>();
  server_region = "jp";
  activity_bonus = 0;
  tea_bonus = 1;
  mode = "normal";
  class_group: string | null = null;
  crown_positions = new Set<string>();
  base_bond = 0;
  sort_mode = SORT_MULTIPLIER;
  candidate_pool_size = 30;
  craft_pool_size = 50;
  top_n = 20;
  timeout_ms = 10000;
  target_servant_id: number | null = null;
  neighborhood = "standard";
  search_order = "servant";
  super_mode = 0;
  stop_file: string | null = null;
  event_priority = false;
  /** 复现用：固定工作量（对应 Python 的 verify_phase_limits） */
  verify_phase_limits: AnyRec | null = null;
}

function asBool(value: any, dflt = false): boolean {
  if (value === null || value === undefined) return dflt;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asFloat(value: any, dflt = 0): number {
  const n = Number(value ?? dflt);
  return Number.isFinite(n) ? n : dflt;
}

function asInt(value: any, dflt = 0): number {
  const n = parseInt(String(value ?? dflt), 10);
  return Number.isFinite(n) ? n : dflt;
}

export function parseBox(rawList: any[]): BoxServant[] {
  const out: BoxServant[] = [];
  for (const raw of rawList ?? []) {
    out.push(
      new BoxServant({
        servant_id: asInt(raw["id"]),
        stage: String(raw["stage"] ?? "fourth"),
        max_bond: asBool(raw["maxBond"], false),
        bond_switch1: asBool(raw["bondSwitch1"], true),
        bond_switch2: asBool(raw["bondSwitch2"], false),
        personal_bonus: asFloat(raw["personalBonus"], 0),
        aura_bonus: asFloat(raw["auraBonus"], 0),
      }),
    );
  }
  return out;
}

export function parseFixedServants(rawList: any[]): FixedServant[] {
  const out: FixedServant[] = [];
  for (const raw of rawList ?? []) {
    if (raw !== null && typeof raw === "object") {
      out.push(
        new FixedServant({
          servant_id: asInt(raw["servantId"] ?? raw["id"]),
          position: raw["position"] ?? null,
          stage: raw["stage"] ?? null,
        }),
      );
    } else {
      out.push(new FixedServant({ servant_id: asInt(raw) }));
    }
  }
  return out;
}

export function parseFixedCrafts(rawList: any[]): FixedCraft[] {
  const out: FixedCraft[] = [];
  for (const raw of rawList ?? []) {
    out.push(
      new FixedCraft({
        position: String(raw["position"]),
        craft_id: asInt(raw["craftId"]),
        type: String(raw["type"] ?? "bond").toLowerCase(),
        slot: asInt(raw["slot"] ?? raw["craftIndex"] ?? 0),
      }),
    );
  }
  return out;
}

export function parseSupport(raw: any): SupportConfig | null {
  if (!raw) return null;
  if (raw !== null && typeof raw === "object") {
    const hasServant = raw["servantId"] !== null && raw["servantId"] !== undefined;
    const hasCraft = raw["craftId"] !== null && raw["craftId"] !== undefined;
    const hasSecond = raw["secondCraftId"] !== null && raw["secondCraftId"] !== undefined;
    if (!hasServant && !hasCraft && !hasSecond) {
      return new SupportConfig({ position: raw["position"] ?? null });
    }
    return new SupportConfig({
      servant_id: hasServant ? asInt(raw["servantId"]) : null,
      craft_id: hasCraft ? asInt(raw["craftId"]) : null,
      second_craft_id: hasSecond ? asInt(raw["secondCraftId"]) : null,
      position: raw["position"] ?? null,
    });
  }
  return null;
}

export function parseRequest(data: AnyRec): CalculationRequest {
  const req = new CalculationRequest();
  const strategy = data["strategy"] || STRATEGY_TOTAL_MAX;
  const baseBond = asFloat(data["baseBond"], 0);
  const rawSort = String(data["sortMode"] ?? "").trim().toLowerCase();
  let sortMode: string;
  if (rawSort === SORT_MULTIPLIER || rawSort === SORT_POINTS) sortMode = rawSort;
  else sortMode = baseBond > 0 ? SORT_POINTS : SORT_MULTIPLIER;
  if (sortMode === SORT_POINTS && baseBond <= 0) sortMode = SORT_MULTIPLIER;

  req.box = parseBox(data["box"] ?? []);
  req.fixed_servants = parseFixedServants(data["fixedServants"] ?? []);
  req.fixed_crafts = parseFixedCrafts(data["fixedCrafts"] ?? []);
  req.support = parseSupport(data["support"]);
  req.cost_limit = asInt(data["costLimit"] ?? 114, 114) || 114;
  req.strategy = strategy;
  req.excluded_servant_ids = new Set((data["excludedServantIds"] ?? []).map((x: any) => asInt(x)));
  req.excluded_craft_ids = new Set((data["excludedCraftIds"] ?? []).map((x: any) => asInt(x)));
  req.support_excluded_craft_ids = new Set(
    (data["supportExcludedCraftIds"] ?? []).map((x: any) => asInt(x)),
  );
  req.server_region = String(data["serverRegion"] ?? "jp").toLowerCase();
  req.activity_bonus = asFloat(data["activityBonus"], 0);
  req.tea_bonus = asFloat(data["teaBonus"] ?? 1, 1) || 1;
  req.mode = String(data["mode"] ?? "normal").toLowerCase() || "normal";
  req.class_group = data["classGroup"] ?? data["classFilter"] ?? "all";
  req.crown_positions = new Set<string>(
    (data["crownPositions"] ?? []).map((x: any) => String(x)),
  );
  req.base_bond = baseBond;
  req.sort_mode = sortMode;
  req.top_n = asInt(data["topN"] ?? 20, 20) || 20;
  req.timeout_ms = asInt(data["timeoutMs"] ?? 10000, 10000) || 10000;
  req.candidate_pool_size = asInt(data["candidatePoolSize"] ?? 30, 30) || 30;
  req.craft_pool_size = asInt(data["craftPoolSize"] ?? 10, 10) || 10;

  let neighborhood = String(data["neighborhood"] ?? "standard").trim().toLowerCase() || "standard";
  if (!["off", "standard", "deep"].includes(neighborhood)) neighborhood = "standard";
  req.neighborhood = neighborhood;

  let order = String(data["searchOrder"] ?? "servant").trim().toLowerCase() || "servant";
  if (!["servant", "craft"].includes(order)) order = "servant";
  req.search_order = order;

  if (req.class_group === null || req.class_group === "" || req.class_group === "all") {
    req.class_group = null;
  }

  let superMode = 0;
  try {
    superMode = Math.max(0, Number(data["superMode"] ?? 0) || 0);
  } catch {
    superMode = 0;
  }
  req.super_mode = superMode <= 1 ? 0 : superMode;

  const rawStop = String(data["stopFile"] ?? "").trim();
  req.stop_file = rawStop ? rawStop : null;
  // 复现用固定工作量（只给自家闸门 / e2e 用：界面从来不传，Python 侧也是工具直接赋值）。
  // 传了就按它跑，能逐字节复现一次搜索结果。
  const rawLimits = data["phaseLimits"];
  req.verify_phase_limits =
    rawLimits && typeof rawLimits === "object" && !Array.isArray(rawLimits) ? { ...(rawLimits as any) } : null;
  req.event_priority = Boolean(data["eventPriority"]);
  if (strategy === STRATEGY_TARGET_MAX) {
    req.target_servant_id = data["targetServantId"] ?? data[TARGET_SERVANT_KEY] ?? null;
  }
  return req;
}
