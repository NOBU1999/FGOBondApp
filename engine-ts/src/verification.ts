// P3.5+：验证串**生成**链路（对齐 python-engine/engine/verification.py 的生成部分）
//
// 只搬生成侧：应用只"生成 + 复制"验证串（`renderer/app.js` 无导入入口），
// 解码只发生在开发侧 `reproduce_verification.py`（依赖 pyppmd + cryptography，不进仓库）。
//
// ⚠️ 因此 TS 一律生成 **`FGOBONDV3Z.`（zlib + Base64URL）** 变体 ——
//    `verification.decrypt_token` 先判这个前缀，任何旧解码端都认（安卓本来就走这条）。
//    PPMd（`FGOBONDV3.`）与 Fernet（v1/v2）两条分支**故意没搬**。
import { getPlatform } from "./platform.ts";
import { pf, pyDumps } from "./pyjson.ts";
import type { DataContext } from "./calculator.ts";
import { POSITIONS } from "./models.ts";

export const PREFIX_V1 = "FGOBONDV1.";
export const PREFIX_V2 = "FGOBONDV2.";
export const PREFIX_V3 = "FGOBONDV3.";
export const PREFIX_V3_ZLIB = "FGOBONDV3Z.";
export const FORMAT_VERSION = 1;
export const DEFAULT_APP_NAME = "FGO牵绊推荐器";

// ---------------------------------------------------------------------------
// Base64URL
// ---------------------------------------------------------------------------
export function b64urlEncode(data: Uint8Array): string {
  return getPlatform().b64UrlEncode(data);
}

export function b64urlDecode(text: string): Uint8Array {
  return getPlatform().b64UrlDecode(text);
}

/** 把 dict key / 数组等转成可 JSON 序列化结构（对齐 `_jsonable`） */
export function jsonable(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(jsonable);
  if (value instanceof Set) {
    return [...value].map(jsonable).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (value instanceof Map) {
    const out: Record<string, any> = {};
    for (const [k, v] of value) out[String(k)] = jsonable(v);
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[String(k)] = jsonable(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------
export interface SnapshotCraft {
  id: number;
  name: string;
  cost: number;
  rarity: number;
  bonusType: string | null;
  bonusValue: ReturnType<typeof pf>;
  supportBonus: ReturnType<typeof pf>;
  triggerTraits: string[][];
  isBondCe: boolean;
  detail: string;
  isEventLimited: boolean;
  flatBonus: ReturnType<typeof pf>;
  repeatable: boolean;
  isCustom: boolean;
}

/** 把运行时 DataContext 序列化为自包含快照（字段顺序不影响，dump 时按 key 排序） */
export function ctxSnapshot(ctx: DataContext): { servants: any[]; crafts: SnapshotCraft[] } {
  const servantIds = [...ctx.servants.keys()].sort((a, b) => a - b);
  const servants: any[] = [];
  for (const sid of servantIds) {
    const info = ctx.servants.get(sid)!;
    const traits: Record<string, string[]> = {};
    for (const stage of Object.keys(info.traits).sort()) {
      traits[stage] = [...new Set(info.traits[stage])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    servants.push({
      id: info.id,
      name: info.name,
      class: info.servant_class,
      cost: info.cost,
      rarity: info.rarity,
      traits,
    });
  }
  const craftIds = [...ctx.crafts.keys()].sort((a, b) => a - b);
  const crafts: SnapshotCraft[] = [];
  for (const cid of craftIds) {
    const c = ctx.crafts.get(cid)!;
    crafts.push({
      id: c.id,
      name: c.name,
      cost: c.cost,
      rarity: c.rarity,
      bonusType: c.bonus_type,
      bonusValue: pf(c.bonus_value),
      supportBonus: pf(c.support_bonus),
      triggerTraits: (c.trigger_traits ?? []).map((g) => [...g]),
      isBondCe: c.is_bond_ce,
      detail: c.detail,
      isEventLimited: c.is_event_limited,
      flatBonus: pf(c.flat_bonus),
      repeatable: c.repeatable,
      isCustom: c.is_custom,
    });
  }
  return { servants, crafts };
}

function intOrNone(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/** 按本次请求裁剪快照（复现模式：只留 Box/固定/助战/目标 + 全体从者骨架 + 牵绊礼装） */
export function trimSnapshotForRequest(
  snapshot: { servants: any[]; crafts: SnapshotCraft[] },
  requestData: Record<string, any>,
): { servants: any[]; crafts: SnapshotCraft[] } {
  const req = requestData ?? {};
  const keepServantIds = new Set<number>();

  for (const raw of req["box"] ?? []) {
    const sid = raw && typeof raw === "object" ? intOrNone(raw["id"]) : intOrNone(raw);
    if (sid !== null) keepServantIds.add(sid);
  }
  for (const raw of req["fixedServants"] ?? []) {
    let sid: number | null;
    if (raw && typeof raw === "object") {
      sid = intOrNone(raw["servantId"] !== null && raw["servantId"] !== undefined ? raw["servantId"] : raw["id"]);
    } else {
      sid = intOrNone(raw);
    }
    if (sid !== null) keepServantIds.add(sid);
  }

  const support = req["support"];
  let manualSupportId: number | null = null;
  const supportCraftIds = new Set<number>();
  if (support && typeof support === "object") {
    manualSupportId = intOrNone(support["servantId"]);
    if (manualSupportId !== null) keepServantIds.add(manualSupportId);
    for (const key of ["craftId", "secondCraftId"]) {
      const cid = intOrNone(support[key]);
      if (cid !== null) supportCraftIds.add(cid);
    }
  }

  const targetId = intOrNone(req["targetServantId"] || req["target_servant_id"]);
  if (targetId !== null) keepServantIds.add(targetId);

  const fixedCraftIds = new Set<number>();
  for (const raw of req["fixedCrafts"] ?? []) {
    let cid: number | null;
    if (raw && typeof raw === "object") {
      cid = intOrNone(raw["craftId"] !== null && raw["craftId"] !== undefined ? raw["craftId"] : raw["id"]);
    } else {
      cid = intOrNone(raw);
    }
    if (cid !== null) fixedCraftIds.add(cid);
  }

  // 自动助战要从全体从者里按职阶选 ID 最小者；保留"ID + 职阶"骨架即可
  const needAllServantIds = manualSupportId === null;
  const newServants: any[] = [];
  for (const s of snapshot.servants ?? []) {
    const sid = intOrNone(s["id"]);
    if (sid !== null && keepServantIds.has(sid)) {
      newServants.push(s);
    } else if (needAllServantIds) {
      newServants.push({
        id: s["id"],
        name: "",
        class: s["class"] ?? "",
        cost: 0,
        rarity: 0,
        traits: {},
      });
    }
  }

  const keepCraftIds = new Set<number>([0, -1, -2, -3, -4, -5, -10, -20, -21, -22]);
  for (const cid of fixedCraftIds) keepCraftIds.add(cid);
  for (const cid of supportCraftIds) keepCraftIds.add(cid);
  for (const c of snapshot.crafts ?? []) {
    if (c.isBondCe) {
      const cid = intOrNone(c.id);
      if (cid !== null) keepCraftIds.add(cid);
    }
  }
  const newCrafts = (snapshot.crafts ?? []).filter((c) => {
    const cid = intOrNone(c.id);
    return cid !== null && keepCraftIds.has(cid);
  });

  return { servants: newServants, crafts: newCrafts };
}

// ---------------------------------------------------------------------------
// 结果基线压缩
// ---------------------------------------------------------------------------
export function compactMember(m: Record<string, any>): Record<string, any> {
  return {
    position: String(m["position"] ?? ""),
    servantId: m["servantId"] ?? null,
    stage: m["stage"] ?? null,
    craftId: m["craftId"] ?? null,
    secondCraftId: m["secondCraftId"] ?? null,
    isSupport: Boolean(m["isSupport"]),
  };
}

export function compactResult(r: Record<string, any>): Record<string, any> {
  return {
    rank: Math.trunc(Number(r["rank"] ?? 0)) || 0,
    totalMultiplier: pf(Number(r["totalMultiplier"] ?? 0)),
    costUsed: Math.trunc(Number(r["costUsed"] ?? 0)) || 0,
    baseBond: pf(Number(r["baseBond"] ?? 0)),
    totalBondPoints: pf(Number(r["totalBondPoints"] ?? 0)),
    maxBondCount: Math.trunc(Number(r["maxBondStats"]?.count ?? 0)) || 0,
    team: (r["team"] ?? []).map((m: any) => compactMember(m)),
  };
}

export function compactResults(results: any[]): any[] {
  return (results ?? []).map((r) => compactResult(r));
}

// ---------------------------------------------------------------------------
// payload / 串
// ---------------------------------------------------------------------------
export interface BuildPayloadOptions {
  appName?: string;
  compact?: boolean;
  /** 覆盖 createdAt（测试用；不给就取 UTC 当前时间） */
  createdAt?: string;
}

export function isoUtcNow(d: Date = new Date()): string {
  // 对齐 `datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")`：
  // Python 的 isoformat 带 **6 位微秒**，JS 的 toISOString 只有 3 位 → 补三个 0。
  // （值本身当然不同；闸门里会把它掩掉。）
  const iso = d.toISOString(); // 2026-10-24T13:45:12.123Z
  const m = /^(.*T\d{2}:\d{2}:\d{2}\.)(\d{3})Z$/.exec(iso);
  if (!m) return iso;
  return `${m[1]}${m[2]}000Z`;
}

export function buildPayload(
  ctx: DataContext,
  requestData: Record<string, any>,
  result: Record<string, any>,
  opts: BuildPayloadOptions = {},
): Record<string, any> {
  const appName = opts.appName ?? DEFAULT_APP_NAME;
  const compact = opts.compact ?? true;
  let snapshot: any = ctxSnapshot(ctx);
  if (compact) snapshot = trimSnapshotForRequest(snapshot, requestData);
  const processed = result["_processed"];
  const elapsed = result["_elapsed"];
  return {
    formatVersion: FORMAT_VERSION,
    appName,
    createdAt: opts.createdAt ?? isoUtcNow(),
    request: jsonable(requestData),
    snapshot,
    baseline: compactResults(result["top20"] ?? []),
    phaseLimits: result["_verifyPhase"] ?? null,
    meta: {
      totalCandidates: result["totalCandidates"] ?? null,
      elapsed: elapsed === null || elapsed === undefined ? null : pf(Number(elapsed)),
      processed: processed === null || processed === undefined ? null : Math.trunc(Number(processed)),
    },
  };
}

/** payload → 序列化文本（Python `json.dumps(..., separators=(",",":"), sort_keys=True)` 等价） */
export function payloadText(payload: Record<string, any>): string {
  return pyDumps(payload, { separators: [",", ":"], sortKeys: true });
}

/** payload → 验证串（`FGOBONDV3Z.` + zlib + Base64URL）
 *  ⚠️ async：网页宿主的压缩只能走 CompressionStream（流式），桌面侧内部仍是同步 zlib。 */
export async function encryptPayload(payload: Record<string, any>): Promise<string> {
  const p = getPlatform();
  const raw = p.utf8Encode(payloadText(payload));
  const compressed = await p.deflate(raw, 9);
  return PREFIX_V3_ZLIB + b64urlEncode(compressed);
}

export async function makeVerificationToken(
  ctx: DataContext,
  requestData: Record<string, any>,
  result: Record<string, any>,
  opts: BuildPayloadOptions = {},
): Promise<string> {
  return encryptPayload(buildPayload(ctx, requestData, result, opts));
}

export async function makeVerificationTokens(
  ctx: DataContext,
  requestData: Record<string, any>,
  result: Record<string, any>,
  opts: BuildPayloadOptions = {},
): Promise<{ repro: string; full: string }> {
  return {
    repro: await makeVerificationToken(ctx, requestData, result, { ...opts, compact: true }),
    full: await makeVerificationToken(ctx, requestData, result, { ...opts, compact: false }),
  };
}

/**
 * 解码验证串（**只支持 `FGOBONDV3Z.`**）。
 *
 * 故意不做 PPMd / Fernet：应用没有"导入验证串"的入口，历史串由开发侧
 * `reproduce_verification.py` 解（那边有 pyppmd + cryptography）。
 * 这里实现 V3Z 只为（a）自检/往返测试，（b）将来若真要做应用内导入，至少 V3Z 是通的。
 */
export async function decryptTokenV3Z(token: string): Promise<Record<string, any>> {
  const t = (token ?? "").trim();
  if (!t.startsWith(PREFIX_V3_ZLIB)) {
    if (t.startsWith(PREFIX_V3) || t.startsWith(PREFIX_V2) || t.startsWith(PREFIX_V1)) {
      throw new Error("该验证串是 PPMd / Fernet 版本，请用开发侧 reproduce_verification.py 解码");
    }
    throw new Error("验证串格式不正确：缺少 FGOBONDV3Z. 前缀");
  }
  const p = getPlatform();
  const raw = await p.inflate(b64urlDecode(t.slice(PREFIX_V3_ZLIB.length)));
  const payload = JSON.parse(p.utf8Decode(raw));
  if (Math.trunc(Number(payload["formatVersion"] ?? 0)) !== FORMAT_VERSION) {
    throw new Error(`不支持的验证串格式版本: ${payload["formatVersion"]}`);
  }
  return payload;
}

export const __positions = POSITIONS;
