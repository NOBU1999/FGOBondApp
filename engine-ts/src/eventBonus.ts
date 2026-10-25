// P3.5：活动牵绊加成解析 + event_bond_bonus.json 生成
// （对齐旧实现的 event_bonus）
import fs from "node:fs";
import path from "node:path";
import { pyRound } from "./evaluate.ts";
import { pf, pyDumps } from "./pyjson.ts";
import { dataCfg, getRemoteExportMeta, loadJsonCached } from "./dataFetch.ts";
import type { DataConfig } from "./dataFetch.ts";
import { BASIC_EVENT_FILE, NICE_EVENT_FILE, NICE_SERVANT_FILE, STAGES } from "./dataFetch.ts";
import { connectWrite, exportDb, initDb, setMeta } from "./databaseWrite.ts";

export const BOND_TARGETS = new Set(["questFriendship"]);

export function loadEventTranslations(): Record<string, Record<string, string>> {
  const baseDir = dataCfg.engineDataDir;
  let result: Record<string, Record<string, string>> = {};
  const p = path.join(baseDir, "name_translations.json");
  if (fs.existsSync(p)) result = JSON.parse(fs.readFileSync(p, "utf8"));
  // 手工补充表：新活动在社区译名/官方简中上线之前，先用这里顶一个非官方译名。
  // 单独一个文件是故意的 —— name_translations.json 是脚本生成的，重生成会覆盖掉。
  const extra = path.join(baseDir, "event_names_extra.json");
  if (fs.existsSync(extra)) {
    try {
      const overrides = JSON.parse(fs.readFileSync(extra, "utf8"))?.event_names ?? {};
      result["event_names"] = { ...(result["event_names"] ?? {}), ...overrides };
    } catch {
      /* 补充表坏了就当没有 */
    }
  }
  return result;
}

export function translateEventName(rawName: string): string {
  if (!rawName) return rawName ?? "";
  const table = loadEventTranslations()["event_names"] ?? {};
  return table[rawName] || rawName;
}

export function looksJapanese(value: string | null | undefined): boolean {
  return /[\u3040-\u30ff\u31f0-\u31ff]/.test(value ?? "");
}

/** 去掉活动名后面"关联从者获得牵绊点数提升xx%"之类的附加说明 */
export function cleanEventName(qCn: string, campaignCn = ""): string {
  if (!looksJapanese(qCn)) return qCn;
  const m = /[「『]([^」』]+)[」』]/.exec(campaignCn || "");
  if (m) return m[1].trim();
  const cleaned = (campaignCn || qCn).replace(/(关联从者|関連サーヴァント|関連从者|獲得|获得).*$/u, "");
  return cleaned.trim() || qCn;
}

export function normText(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s\r\n「」『』・･()（）]/gu, "").toLowerCase();
}

export function bracketTitle(value: string | null | undefined): string | null {
  const m = /[「『]([^」』]+)[」』]/.exec(value ?? "");
  return m ? m[1].trim() : null;
}

/** 把 questCampaign 的牵绊加成挂到对应 eventQuest（关卡配置活动）上 */
export function findMatchingEventQuest(ev: any, eventQuests: any[]): any | null {
  const title = bracketTitle(ev?.name ?? "");
  if (!title) return null;

  const titleN = normText(title);
  const cStart = ev?.startedAt ?? 0;
  const cEnd = ev?.endedAt ?? 0;

  const timeClose = (q: any): boolean => {
    const qs = q?.startedAt ?? 0;
    const qe = q?.endedAt ?? 0;
    // 活动前 campaign 可能与 eventQuest 首尾相邻；允许最多 20 天间隔
    const gapBefore = cEnd ? qs - cEnd : 0;
    const gapAfter = (cStart || 0) - qe;
    let close = false;
    if (cStart && qs && cEnd && qe) {
      close = !(cEnd < qs - 20 * 86400 || cStart > qe + 20 * 86400);
    }
    return close || Math.max(Math.abs(gapBefore), Math.abs(gapAfter)) <= 20 * 86400;
  };

  let best: any = null;
  let bestScore = -1;
  for (const q of eventQuests) {
    const qnameN = normText(q?.name ?? "");
    let score = 0;
    if (titleN && (qnameN.includes(titleN) || titleN.includes(qnameN))) score += 10;
    if (timeClose(q)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  // 必须名称匹配到 eventQuest，避免把 Lostbelt/泛用 campaign 挂错
  if (bestScore < 10) return null;
  return best;
}

export type BonusMap = Map<number, Map<string, Map<number, Set<number>>>>;

/** nice_servant.json 的 extraPassive 里提取活动限定牵绊加成 */
export function extractExtraPassiveFriendship(servants: any[]): BonusMap {
  const result: BonusMap = new Map();
  for (const servant of servants ?? []) {
    const servantId = parseInt(String(servant?.id ?? 0), 10);
    if (!Number.isFinite(servantId) || servantId <= 0) continue;

    for (const skill of servant?.extraPassive ?? []) {
      for (const func of skill?.functions ?? []) {
        if (func?.funcType !== "servantFriendshipUp") continue;
        let rateCount = 0;
        for (const sv of func?.svals ?? []) {
          const v = parseInt(String(sv?.RateCount ?? 0), 10);
          if (Number.isFinite(v) && v > rateCount) rateCount = v;
        }
        if (!rateCount) continue;
        // RateCount 单位是 0.1%，500 = 50%
        const friendshipPercent = pyRound(rateCount / 10.0, 2);
        const targetType = func?.funcTargetType ?? "self";
        const scope = targetType === "ptFull" ? "team" : "self";

        for (const grant of skill?.extraPassive ?? []) {
          const eventId = parseInt(String(grant?.eventId ?? 0), 10);
          if (!Number.isFinite(eventId) || eventId <= 0) continue;
          let byScope = result.get(eventId);
          if (!byScope) {
            byScope = new Map();
            result.set(eventId, byScope);
          }
          let byPercent = byScope.get(scope);
          if (!byPercent) {
            byPercent = new Map();
            byScope.set(scope, byPercent);
          }
          let ids = byPercent.get(friendshipPercent);
          if (!ids) {
            ids = new Set();
            byPercent.set(friendshipPercent, ids);
          }
          ids.add(servantId);
        }
      }
    }
  }
  return result;
}

export function addBonus(
  bonusMap: BonusMap,
  eventId: number,
  scope: string,
  bonusPercent: number,
  servantIds: number[],
): void {
  if (servantIds.length === 0) return;
  let byScope = bonusMap.get(eventId);
  if (!byScope) {
    byScope = new Map();
    bonusMap.set(eventId, byScope);
  }
  let byPercent = byScope.get(scope);
  if (!byPercent) {
    byPercent = new Map();
    byScope.set(scope, byPercent);
  }
  const key = pyRound(bonusPercent, 2);
  let ids = byPercent.get(key);
  if (!ids) {
    ids = new Set();
    byPercent.set(key, ids);
  }
  for (const x of servantIds) ids.add(parseInt(String(x), 10));
}

export function parseEventBondBonuses(
  events: any[],
  servants: any[] | null = null,
  cnNamesById: Map<number, string> | null = null,
): any[] {
  const evs = events ?? [];
  const eventQuests = evs.filter((e) => e?.type === "eventQuest" && (e?.warIds ?? []).length > 0);
  const questById = new Map<number, any>();
  for (const e of eventQuests) questById.set(parseInt(String(e?.id ?? 0), 10), e);

  const bonusMap: BonusMap = new Map();
  const nameFallback = new Map<number, string>();

  // 来源 1：questFriendship campaign（兜底/旧数据兼容，均为单体 self）
  for (const ev of evs) {
    if (ev?.type === "eventQuest") continue;
    for (const camp of ev?.campaigns ?? []) {
      if (!BOND_TARGETS.has(camp?.target)) continue;
      const value = parseInt(String(camp?.value ?? 0), 10);
      if (!Number.isFinite(value) || value <= 1000) continue;
      const rawIds: any[] = camp?.targetIds ?? [];
      const idSet = new Set<number>();
      for (const x of rawIds) {
        if (/^\d+$/.test(String(x))) idSet.add(parseInt(String(x), 10));
      }
      const servantIds: number[] = [...idSet].sort((a, b) => a - b);
      if (servantIds.length === 0) continue; // 无具体从者的泛用/道具类加成不导入个人加成
      const bonusPercent = pyRound((value - 1000) / 10.0, 2);

      const quest = findMatchingEventQuest(ev, eventQuests);
      if (quest === null) continue;

      const eventId = parseInt(String(quest?.id ?? 0), 10);
      const campaignCn = translateEventName(ev?.name ?? "");
      if (looksJapanese(translateEventName(quest?.name ?? "")) && campaignCn) {
        if (!nameFallback.has(eventId)) nameFallback.set(eventId, campaignCn);
      }
      addBonus(bonusMap, eventId, "self", bonusPercent, servantIds);
    }
  }

  // 来源 2：nice_servant extraPassive（主数据，含 50/20/5 等分级）
  if (servants) {
    for (const [eventId, byScope] of extractExtraPassiveFriendship(servants)) {
      if (!questById.has(eventId)) continue;
      for (const [scope, byPercent] of byScope) {
        for (const [bonusPercent, ids] of byPercent) {
          addBonus(bonusMap, eventId, scope, bonusPercent, [...ids].sort((a, b) => a - b));
        }
      }
    }
  }

  const result: any[] = [];
  const cnNames = cnNamesById ?? new Map<number, string>();
  const sortedQuests = [...eventQuests].sort((a, b) => {
    // Python: sorted(..., key=startedAt, reverse=True) 稳定
    const va = a?.startedAt ?? 0;
    const vb = b?.startedAt ?? 0;
    return vb - va;
  });
  for (const q of sortedQuests) {
    const qid = parseInt(String(q?.id ?? 0), 10);
    let qCn = translateEventName(q?.name ?? "");
    // 对照表里没有（一般是刚上的新活动）→ 按 id 找 CN 官方译名
    if (looksJapanese(qCn)) {
      const official = cnNames.get(qid);
      if (official && !looksJapanese(official)) qCn = official;
    }
    // 若 eventQuest 名仍是日文，尝试用关联 questCampaign 的中文活动名，并去掉加成说明尾巴
    const eventName = cleanEventName(qCn, nameFallback.get(qid) ?? "");
    const eventBucket = bonusMap.get(qid) ?? new Map<string, Map<number, Set<number>>>();
    const bonuses: any[] = [];
    for (const [scope, byPercent] of eventBucket) {
      for (const [percent, ids] of byPercent) {
        bonuses.push({
          bonusPercent: pf(percent),
          servantIds: [...ids].sort((a, b) => a - b),
          scope,
        });
      }
    }
    // 展示/导入顺序：team 光环放前面，其次按百分比从高到低
    bonuses.sort((a, b) => {
      const sa = a.scope === "team" ? 0 : 1;
      const sb = b.scope === "team" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return b.bonusPercent.value - a.bonusPercent.value;
    });
    result.push({
      eventId: qid,
      eventName,
      startedAt: q?.startedAt ?? null,
      endedAt: q?.endedAt ?? null,
      bonuses,
    });
  }
  return result;
}

export interface EventBonusOptions {
  region?: string;
  dbPath?: string | null;
  useCache?: boolean;
  progress?: ((message: string) => void) | null;
  /** 下载明细（每 2% 一行）——界面进度条靠它，默认只写 stderr */
  downloadLog?: ((message: string) => void) | null;
  sqlFactory?: any;
}

export async function updateEventBondBonus(opts: EventBonusOptions = {}): Promise<Record<string, any>> {
  const region = opts.region ?? "JP";
  const useCache = opts.useCache ?? true;
  const progress = opts.progress ?? null;
  const downloadLog = opts.downloadLog ?? undefined;

  if (progress) progress("正在下载活动数据...");
  const events = await loadJsonCached(
    region,
    NICE_EVENT_FILE,
    dataCfg.rawCacheDir,
    "nice_event",
    useCache,
    downloadLog,
  );

  if (progress) progress("正在读取从者活动被动技能...");
  const servants = await loadJsonCached(
    region,
    NICE_SERVANT_FILE,
    dataCfg.rawCacheDir,
    "nice_servant",
    useCache,
    downloadLog,
  );

  if (progress) progress("正在解析活动牵绊加成...");
  // CN 官方中文名（basic 层只有 0.44MB；拿不到就算了）
  let cnNamesById = new Map<number, string>();
  try {
    const cnBasic = await loadJsonCached(
      "CN",
      BASIC_EVENT_FILE,
      dataCfg.rawCacheDir,
      "basic_event_cn",
      useCache,
      downloadLog,
    );
    cnNamesById = new Map<number, string>();
    for (const e of cnBasic ?? []) {
      if (e?.id) cnNamesById.set(parseInt(String(e["id"]), 10), e?.name ?? "");
    }
  } catch {
    cnNamesById = new Map();
  }

  const records = parseEventBondBonuses(events, servants, cnNamesById);

  const dbPath = opts.dbPath ?? dataCfg.dbPath;
  const out = path.join(path.dirname(dbPath), "event_bond_bonus.json");
  fs.writeFileSync(out, pyDumps(records, { indent: 2 }), "utf8");

  // 记下这次用的 nice_event.json 的 etag，供「检查刷新」判断"活动有新内容"
  try {
    const meta = await getRemoteExportMeta(region, NICE_EVENT_FILE);
    const db = await connectWrite(dbPath, opts.sqlFactory);
    initDb(db);
    setMeta(db, "event_etag", meta?.etag ?? "");
    exportDb(db, dbPath);
  } catch {
    /* 记不上不影响活动表本身 */
  }

  const eventCount = new Set(records.map((r) => r.eventId)).size;
  const bonusCount = records.reduce((n, r) => n + r.bonuses.length, 0);
  if (progress) progress(`活动牵绊加成解析完成：${eventCount} 个活动，${bonusCount} 条加成`);
  return {
    event_bond_events: eventCount,
    event_bond_records: bonusCount,
    event_bond_file: out,
  };
}

export const __stages = STAGES;
export const __cfg: DataConfig = dataCfg;
