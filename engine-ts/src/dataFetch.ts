// P3.5 数据管线：Atlas Academy 拉取 + 全量建库（对齐旧实现的 data_fetcher）
//
// 判据与引擎侧一致：**同样输入 ⇒ 同样的库**。网络那几条路（分段 Range + 分段重试、
// HEAD 元信息、灵衣名 raw 单从者接口）在离线闸门里被关掉，其余全部走真实实现。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { bodyReadable, currentProxy, httpRequest, proxyLabel, readAll } from "./proxy.ts";
import { pyDumps } from "./pyjson.ts";
import {
  clearDataTables,
  connectWrite,
  finalizeStatements,
  exportDb,
  getMeta,
  initDb,
  setMeta,
  upsertCostumeName,
  upsertCostumeTraits,
  upsertCostumeTraitsCn,
  upsertCraft,
  upsertServant,
  upsertStageTraits,
  upsertStageTraitsCn,
} from "./databaseWrite.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 配置（默认按将来的仓库布局；闸门/测试用 configureDataPaths 覆盖）
// ---------------------------------------------------------------------------
export interface DataConfig {
  /** FGOBondApp 根 */
  projectRoot: string;
  /** 仓库 `data/`（译名表、活动名补充、阶段特性补丁） */
  engineDataDir: string;
  /** `<应用根>/.cache/raw` */
  rawCacheDir: string;
  /** 默认库路径 */
  dbPath: string;
  /** 关掉网络（离线闸门 / 无网环境）：所有 fetch 直接抛错 */
  netEnabled: boolean;
}

export const dataCfg: DataConfig = {
  projectRoot: path.resolve(HERE, "..", ".."),
  engineDataDir: path.resolve(HERE, "..", "..", "data"),
  rawCacheDir: path.resolve(HERE, "..", "..", ".cache", "raw"),
  dbPath: process.env.FGO_DB_PATH
    ? process.env.FGO_DB_PATH
    : path.resolve(HERE, "..", "..", "db", "fgo_data.db"),
  netEnabled: true,
};

export function configureDataPaths(over: Partial<DataConfig>): void {
  Object.assign(dataCfg, over);
}

// ---------------------------------------------------------------------------
// 常量（对齐 constants.py）
// ---------------------------------------------------------------------------
export const ATLAS_API_ROOT = "https://api.atlasacademy.io";
export const ATLAS_EXPORT_ROOT = `${ATLAS_API_ROOT}/export/{region}`;
export const NICE_SERVANT_FILE = "nice_servant.json";
export const NICE_EQUIP_FILE = "nice_equip.json";
export const NICE_EVENT_FILE = "nice_event.json";
export const BASIC_EVENT_FILE = "basic_event.json";
export const BASIC_SERVANT_FILE = "basic_servant.json";
export const BASIC_EQUIP_FILE = "basic_equip.json";

export const SUPPORTED_REGIONS = new Set(["JP", "NA", "CN", "KR", "TW"]);
export const DEFAULT_REGION = (process.env.FGO_REGION ?? "JP").toUpperCase();
export const ASCENSION_KEYS = ["0", "1", "2", "3", "4"] as const;
export const STAGES = ["initial", "first", "second", "third", "fourth"] as const;

const HTTP_TIMEOUT_MS = 120 * 1000;
const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_RETRY_WAIT_MS = 1500;

/** 可进入玩家 Box 的从者 type（过滤敌方/NPC 等） */
export const PLAYABLE_SERVANT_TYPES = new Set(["normal", "heroine"]);
/** 礼装 type */
export const CRAFT_EQUIP_TYPES = new Set(["servantEquip"]);

/** Atlas ascensionAdd.attribute 的取值 → trait 机器名 */
export const ATTRIBUTE_VALUE_TO_TRAIT: Record<string, string> = {
  star: "attributeStar",
  sky: "attributeSky",
  earth: "attributeEarth",
  man: "attributeMan",
  human: "attributeMan",
  beast: "attributeBeast",
};
export const ATTRIBUTE_TRAIT_NAMES = new Set(Object.values(ATTRIBUTE_VALUE_TO_TRAIT));

export type TraitPair = [string, number | null];

// ---------------------------------------------------------------------------
// 译名表（JP → CN）
// ---------------------------------------------------------------------------
let TRANSLATION_CACHE: Record<string, Record<string, string>> | null = null;

export function loadTranslations(): Record<string, Record<string, string>> {
  if (TRANSLATION_CACHE !== null) return TRANSLATION_CACHE;
  const p = path.join(dataCfg.engineDataDir, "name_translations.json");
  const loaded: Record<string, Record<string, string>> = fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, "utf8"))
    : {};
  TRANSLATION_CACHE = loaded;
  return loaded;
}

export function translateJpName(rawName: string, section: string): string {
  if (!rawName) return rawName ?? "";
  const table = loadTranslations()[section] ?? {};
  return table[rawName] || rawName;
}

export function regionOrDefault(region: string | null | undefined): string {
  const r = String(region ?? DEFAULT_REGION).toUpperCase();
  if (!SUPPORTED_REGIONS.has(r)) throw new Error(`unsupported region: ${r}`);
  return r;
}

export function exportUrl(region: string, filename: string): string {
  return `${ATLAS_EXPORT_ROOT.replace("{region}", region)}/${filename}`;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------
const UA = "FGOBondApp/0.1";

function assertNet(): void {
  if (!dataCfg.netEnabled) throw new Error("offline: 网络已关闭");
}

export async function fetchBytes(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<Uint8Array> {
  assertNet();
  const r = await httpRequest(url, { headers: { "User-Agent": UA }, timeoutMs });
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`);
  // 走了代理时由我们自己解压（fetch 那条路由 undici 自动解，这里按魔数判断两种情况都对）
  return gunzipIfNeeded(await readAll(r.body));
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** 响应体 → 原始 JSON 字节。
 *  ⚠️ **Node 的 fetch（undici）自己就把 gzip 解开了**，却仍然保留 `content-encoding: gzip` 响应头
 *  （2026-10-25 实测 Atlas：头说 gzip、content-length 370，body 却是 1024 字节明文 JSON）。
 *  旧 Python 实现走 urllib（**不**自动解压）才需要"看头解压"；照抄过来就成了**解压两次** ——
 *  第二次拿到的是明文，zlib 直接报 `incorrect header check`，于是「更新数据」整条挂掉（v0.3.0 就这样）。
 *  ⇒ 只认 gzip **魔数**（1f 8b），不信响应头：宿主解压过也好、没解压过也好，都对。 */
export function gunzipIfNeeded(body: Uint8Array): Uint8Array {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    return new Uint8Array(zlib.gunzipSync(body));
  }
  return body;
}

/** 请求一段原始 JSON 字节区间（Atlas 支持 Range；gzip 时每段独立解压） */
export async function downloadRangeRaw(url: string, start: number, end: number): Promise<[Uint8Array, number]> {
  assertNet();
  const r = await httpRequest(url, {
    headers: { "User-Agent": UA, Range: `bytes=${start}-${end}`, "Accept-Encoding": "gzip" },
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`);
  const body = gunzipIfNeeded(await readAll(r.body));
  if (r.status === 206) {
    let totalRaw = 0;
    const contentRange = r.headers["content-range"] ?? "";
    if (contentRange.includes("/")) {
      totalRaw = parseInt(contentRange.slice(contentRange.lastIndexOf("/") + 1), 10) || 0;
    }
    return [body, totalRaw];
  }
  // 服务器不支持 Range 时整包读取
  return [body, body.length];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DownloadProgress {
  (message: string): void;
}

/** 测试注入点（生产调用不传）：替换单段下载函数 / 退避时间 / 重试次数 */
export interface DownloadOptions {
  rangeRaw?: (url: string, start: number, end: number) => Promise<[Uint8Array, number]>;
  retryWaitMs?: number;
  retries?: number;
  log?: (msg: string) => void;
}

/** 分段 Range 下载到缓存文件（2MiB/段，单段重试 1.5/3/4.5s，4xx 立即抛） */
export async function downloadToCache(
  url: string,
  dest: string,
  label: string,
  progress: DownloadProgress | null = null,
  log: (msg: string) => void = (m) => console.error(m),
  opts: DownloadOptions = {},
): Promise<string> {
  const rangeRaw = opts.rangeRaw ?? downloadRangeRaw;
  const retryWaitMs = opts.retryWaitMs ?? DOWNLOAD_RETRY_WAIT_MS;
  const retries = opts.retries ?? DOWNLOAD_RETRIES;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest.replace(/\.[^./\\]+$/, "") + ".part";
  if (fs.existsSync(part)) fs.unlinkSync(part);

  const rangeSize = 2 * 1024 * 1024;
  const progressStep = 2;
  let start = 0;
  let total: number | null = null;
  let downloaded = 0;
  let lastReported = -1;
  const tStart = Date.now();

  const report = (force = false): void => {
    if (!total) return;
    const percent = Math.min(100, Math.trunc((downloaded * 100) / total));
    if (!force && percent < lastReported + progressStep) return;
    lastReported = percent;
    const elapsed = (Date.now() - tStart) / 1000;
    const speed = elapsed > 0 ? downloaded / elapsed / 1024 / 1024 : 0;
    const eta = downloaded > 0 && elapsed > 0 ? (total - downloaded) / (downloaded / elapsed) : 0;
    log(
      `[data_fetcher] ${label}: ${percent}% ` +
        `(${(downloaded / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB, ` +
        `${speed.toFixed(2)} MB/s` +
        (eta > 0 ? `, 约剩 ${eta.toFixed(0)}s` : "") +
        ")",
    );
  };

  // ⚠️ Node 的 fs 不认 Python 的 "wb"（报 flags invalid），写二进制用 "w"
  const fd = fs.openSync(part, "w");
  try {
    for (;;) {
      const end = start + rangeSize - 1;
      let raw: Uint8Array | null = null;
      let totalRaw = 0;
      let attempt = 0;
      for (;;) {
        try {
          [raw, totalRaw] = await rangeRaw(url, start, end);
          break;
        } catch (exc: any) {
          // 4xx（除 429 限流）是"这个文件就没有"，重试也没用 → 立刻抛
          if (exc instanceof HttpError && exc.status >= 400 && exc.status < 500 && exc.status !== 429) {
            throw exc;
          }
          attempt += 1;
          if (attempt > retries) throw exc;
          const wait = retryWaitMs * attempt;
          log(
            `[data_fetcher] ${label}: 第 ${(downloaded / 1024 / 1024).toFixed(1)} MB 处断开` +
              `（${exc?.name ?? "Error"}），${(wait / 1000).toFixed(1)}s 后重试 ${attempt}/${retries}`,
          );
          await sleep(wait);
        }
      }
      if (!raw || raw.length === 0) break;
      fs.writeSync(fd, raw);
      downloaded += raw.length;
      if (total === null && totalRaw) {
        total = totalRaw;
        log(`[data_fetcher] ${label}: 开始下载，共 ${(total / 1024 / 1024).toFixed(1)} MB`);
      }
      start += raw.length;
      report();
      if (raw.length < rangeSize || (total !== null && downloaded >= total)) break;
      await sleep(50);
    }
  } finally {
    fs.closeSync(fd);
  }

  report(true);
  fs.renameSync(part, dest);
  log(`[data_fetcher] ${label}: done -> ${dest}`);
  if (progress) progress(`${label}: 100%`);
  return dest;
}

/** 本地缓存还算不算新：远端 Last-Modified 比缓存文件时间新 ⇒ 旧了 */
export async function cacheIsFresh(cachePath: string, region: string, filename: string): Promise<boolean> {
  let meta: Record<string, string>;
  try {
    meta = await getRemoteExportMeta(region, filename);
  } catch {
    return true;
  }
  const lastModified = (meta ?? {})["last_modified"] ?? "";
  if (!lastModified) return true;
  const remoteTs = Date.parse(lastModified) / 1000;
  if (!Number.isFinite(remoteTs)) return true;
  try {
    return fs.statSync(cachePath).mtimeMs / 1000 >= remoteTs;
  } catch {
    return false;
  }
}

/** Atlas 的 ETag 响应带 `Vary: Accept-Encoding`：同一份文件，gzip 变体的 ETag 尾巴多一个 `-gzip`
 *  （实测：要 identity 得 `"dmd5s4z6u461158f6g"`，要 gzip 得 `"dmd5s4z6u461158f6g-gzip"`）。
 *  Node 的 fetch 会自动要 gzip，旧 Python 的 urllib 不要 ⇒ 同一份数据在两代引擎里 ETag 形态不同，
 *  一比就是"有更新"（实测能复现：数据已是最新，检查更新仍报四条「有更新」）。
 *  ⇒ 存和比之前都去掉压缩变体后缀，口径与宿主无关。 */
export function normalizeEtag(v: string | null | undefined): string {
  return String(v ?? "").replace(/-(?:gzip|br|deflate)(?=["']?$)/i, "");
}

export async function getRemoteExportMeta(
  region: string | null = null,
  filename: string = NICE_SERVANT_FILE,
): Promise<Record<string, string>> {
  const r = regionOrDefault(region);
  const url = exportUrl(r, filename);
  assertNet();
  const resp = await httpRequest(url, { method: "HEAD", headers: { "User-Agent": UA }, timeoutMs: HTTP_TIMEOUT_MS });
  if (!resp.ok) throw new HttpError(resp.status, `HTTP ${resp.status}`);
  return {
    etag: normalizeEtag(resp.headers["etag"]),
    last_modified: resp.headers["last-modified"] ?? "",
  };
}

const logStderr = (m: string): void => console.error(m);

export async function loadJsonCached(
  region: string,
  filename: string,
  cacheDir: string,
  label: string,
  useCache: boolean,
  log?: (m: string) => void,
): Promise<any[]> {
  const out = log ?? logStderr;
  const cachePath = path.join(cacheDir, `${region}_${filename}`);
  if (useCache && fs.existsSync(cachePath) && (await cacheIsFresh(cachePath, region, filename))) {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  if (useCache && fs.existsSync(cachePath)) {
    out(`[data_fetcher] ${label}: 本地缓存已过期，重新下载`);
  }
  const url = exportUrl(region, filename);
  out(`[data_fetcher] downloading ${url}`);
  if (useCache) {
    // 优先走压缩直传（体积约为 1/9）；失败再退回 2MB 分段（可续传但没压缩）
    let ok = false;
    try {
      await downloadJsonGzip(url, cachePath, label, out);
      ok = true;
    } catch (exc: any) {
      out(`[data_fetcher] ${label}: 压缩直传失败（${exc?.message ?? exc}），改用分段下载`);
    }
    if (!ok) await downloadToCache(url, cachePath, label, null, out);
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }
  const bytes = await fetchBytes(url);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

// ---------------------------------------------------------------------------
// 大文件下载
// ---------------------------------------------------------------------------
/** 大 JSON 导出走 **gzip 单次流式下载**。
 *
 *  实测（2026-10-27，Atlas JP 导出）：从者包 69,257,176 字节 → 压缩后 7,487,794 字节（约 1/9），
 *  耗时 40s → 7.6s。原来的 2MB 分段（Range）下载会让服务端一律回 identity，
 *  压缩收益全丢 —— 这就是「更新数据」又慢又费流量的真正原因。
 *  ⚠️ Range 与 gzip 不能同时用：一，旦带 Range 服务端就不再压缩。
 *  代价是断了要从头再来，所以失败时由调用方退回分段下载（能续传的那条）。
 */
export async function downloadJsonGzip(
  url: string,
  dest: string,
  label: string,
  log: (msg: string) => void,
): Promise<string> {
  assertNet();
  const part = dest.replace(/\.[^./\\]+$/, "") + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(part)) fs.unlinkSync(part);

  // 先问未压缩体积（identity 的 content-length = 解压后的字节数），用来算百分比
  // ⚠️ HEAD 必须显式要 identity：Node 默认会带 gzip，服务端就回压缩体的长度（实测只有 20 字节），
  //    百分比会瞬间 100% 且显示"共 0.0 MB"。
  let total: number | null = null;
  try {
    const head = await httpRequest(url, {
      method: "HEAD",
      headers: { "User-Agent": UA, "Accept-Encoding": "identity" },
      timeoutMs: 60 * 1000,
    });
    if (head.ok) {
      const n = parseInt(head.headers["content-length"] ?? "", 10);
      if (Number.isFinite(n) && n > 0) total = n;
    }
  } catch {
    /* 拿不到就只报已下多少 */
  }

  const t0 = Date.now();
  let downloaded = 0;
  let lastPct = -1;
  const report = (force = false): void => {
    const elapsed = (Date.now() - t0) / 1000;
    const speed = elapsed > 0 ? downloaded / elapsed / 1024 / 1024 : 0;
    if (!total) {
      if (!force && downloaded < 4 * 1024 * 1024) return;
      log(`[data_fetcher] ${label}: 已下载 ${(downloaded / 1024 / 1024).toFixed(1)} MB（${speed.toFixed(2)} MB/s）`);
      return;
    }
    const pct = Math.min(100, Math.trunc((downloaded * 100) / total));
    if (!force && pct < lastPct + 2) return;
    lastPct = pct;
    const eta = downloaded > 0 && elapsed > 0 ? (total - downloaded) / (downloaded / elapsed) : 0;
    log(
      `[data_fetcher] ${label}: ${pct}% ` +
        `(${(downloaded / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB, ` +
        `${speed.toFixed(2)} MB/s` +
        (eta > 0 ? `, 约剩 ${eta.toFixed(0)}s` : "") +
        ")",
    );
  };

  try {
    const resp = await httpRequest(url, {
      headers: { "User-Agent": UA, "Accept-Encoding": "gzip" },
      timeoutMs: 30 * 60 * 1000,
    });
    if (!resp.ok) throw new HttpError(resp.status, `HTTP ${resp.status}`);
    log(
      `[data_fetcher] ${label}: 开始下载` +
        (total ? `，共 ${(total / 1024 / 1024).toFixed(1)} MB（压缩传输）` : "（压缩传输）"),
    );
    const fd = fs.openSync(part, "w");
    try {
      // 两种宿主行为不同：走 fetch 时 undici 已经解压好，走代理时拿到的是原始 gzip 字节。
      // ⇒ 认第一块的头两字节（1f 8b）决定要不要自己解；别信 content-encoding（坑 40b 就是信头信的）。
      const src = bodyReadable(resp.body);
      const it = src[Symbol.asyncIterator]();
      const first = await it.next();
      const pipe = Readable.from(
        (async function* () {
          if (!first.done) yield first.value as Uint8Array;
          for (;;) {
            const n = await it.next();
            if (n.done) return;
            yield n.value as Uint8Array;
          }
        })(),
      );
      const firstChunk = first.done ? null : (first.value as Uint8Array);
      const gz = !!firstChunk && firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;
      const out = gz ? pipe.pipe(zlib.createGunzip()) : pipe;
      for await (const chunk of out) {
        const buf = chunk as Uint8Array;
        fs.writeSync(fd, buf);
        downloaded += buf.length;
        report();
      }
    } finally {
      fs.closeSync(fd);
    }
    report(true);
    fs.renameSync(part, dest);
    log(`[data_fetcher] ${label}: done -> ${dest}`);
    return dest;
  } catch (exc) {
    try {
      if (fs.existsSync(part)) fs.unlinkSync(part);
    } catch {
      /* 清不掉就算了，下次覆盖 */
    }
    throw exc;
  }
}

export async function loadNiceServants(
  region: string | null = null,
  useCache = true,
  cacheDir: string | null = null,
  log?: (m: string) => void,
): Promise<any[]> {
  const r = regionOrDefault(region);
  const dir = cacheDir ?? dataCfg.rawCacheDir;
  fs.mkdirSync(dir, { recursive: true });
  return loadJsonCached(r, NICE_SERVANT_FILE, dir, `nice_servant_${r.toLowerCase()}`, useCache, log);
}

export async function loadNiceEquips(
  region: string | null = null,
  useCache = true,
  cacheDir: string | null = null,
  log?: (m: string) => void,
): Promise<any[]> {
  const r = regionOrDefault(region);
  const dir = cacheDir ?? dataCfg.rawCacheDir;
  fs.mkdirSync(dir, { recursive: true });
  return loadJsonCached(r, NICE_EQUIP_FILE, dir, `nice_equip_${r.toLowerCase()}`, useCache, log);
}

/** 只需要 id / collectionNo / type 时用 basic 包（从者 ~0.5MB、礼装 ~0.8MB），别下整包。 */
export async function loadBasicEntries(
  region: string | null = null,
  filename: string = BASIC_EQUIP_FILE,
  useCache = true,
  log?: (m: string) => void,
): Promise<any[]> {
  const r = regionOrDefault(region);
  const dir = dataCfg.rawCacheDir;
  fs.mkdirSync(dir, { recursive: true });
  return loadJsonCached(r, filename, dir, `${filename.replace(/\.json$/, "")}_${r.toLowerCase()}`, useCache, log);
}

// ---------------------------------------------------------------------------
// 从者解析
// ---------------------------------------------------------------------------
/** 阶段特性人工补丁表（`data/stage_traits_patch.json` 的 stageTraitOverrides） */
let STAGE_PATCH: Record<string, Record<string, string[]>> | null = null;

export function stageTraitOverrides(): Record<string, Record<string, string[]>> {
  if (STAGE_PATCH !== null) return STAGE_PATCH;
  const bundled = path.join(dataCfg.engineDataDir, "stage_traits_patch.json");
  const fallback = path.join(dataCfg.projectRoot, "data", "stage_traits_patch.json");
  const p = fs.existsSync(bundled) ? bundled : fallback;
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    STAGE_PATCH = (data?.stageTraitOverrides ?? {}) as Record<string, Record<string, string[]>>;
  } catch (exc: any) {
    // 补丁缺失不该让更新流程整条失败（Python 侧也只在 stderr 提示一句）
    console.error(`[warn] 读不到阶段特性补丁表 ${p}：${exc?.message ?? exc}`);
    STAGE_PATCH = {};
  }
  return STAGE_PATCH;
}

export function getOverrideTraits(servantId: number, stage: string): string[] {
  const bySid = stageTraitOverrides()[String(servantId)];
  if (!bySid) return [];
  return [...(bySid[stage] ?? [])];
}

export function traitPairs(traits: any[]): TraitPair[] {
  const out: TraitPair[] = [];
  for (const t of traits ?? []) {
    const name = t?.name;
    if (name && name !== "unknown") out.push([String(name), t?.id ?? null]);
  }
  return out;
}

function manualTraitPairs(servantId: number, stage: string): TraitPair[] {
  return getOverrideTraits(servantId, stage).map((name) => [name, null] as TraitPair);
}

/** 无条件、常驻的 traitAdd 追加特性（eventId == 0） */
export function globalTraitAddPairs(servant: any): TraitPair[] {
  const result: TraitPair[] = [];
  const seen = new Set<string>();
  for (const entry of servant?.traitAdd ?? []) {
    if (parseInt(String(entry?.eventId ?? 0), 10) !== 0) continue;
    for (const t of entry?.trait ?? []) {
      const name = t?.name;
      if (!name || name === "unknown") continue;
      if (seen.has(name)) continue;
      seen.add(name);
      result.push([String(name), t?.id ?? null]);
    }
  }
  return result;
}

/** 应用 Atlas ascensionAdd.attribute 的属性整体覆盖（如星→人） */
export function applyAttributeOverride(traits: TraitPair[], attributeValue: any): TraitPair[] {
  if (!attributeValue) return traits;
  const newName = ATTRIBUTE_VALUE_TO_TRAIT[String(attributeValue).toLowerCase()];
  if (!newName) return traits;
  const result = traits.filter(([name]) => !ATTRIBUTE_TRAIT_NAMES.has(name));
  const names = new Set(result.map(([n]) => n));
  if (!names.has(newName)) result.push([newName, null]);
  return result;
}

/** 某从者五个灵基阶段的特性集合 */
export function resolveStageTraitSets(servant: any): Map<string, TraitPair[]> {
  const servantId = parseInt(String(servant["id"]), 10);
  const baseTraits = traitPairs(servant?.traits ?? []);
  const ascensionAdd = (servant?.ascensionAdd?.individuality?.ascension ?? {}) as Record<string, any[]>;
  const attributeAsc = (servant?.ascensionAdd?.attribute?.ascension ?? {}) as Record<string, any>;

  const result = new Map<string, TraitPair[]>();
  const globalAdd = globalTraitAddPairs(servant);
  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const ascKey = ASCENSION_KEYS[i];
    const raw = ascensionAdd[ascKey] ?? [];
    let traits: TraitPair[];
    if (Array.isArray(raw) && raw.length > 0) {
      traits = traitPairs(raw);
    } else {
      traits = baseTraits.map(([n, t]) => [n, t] as TraitPair);
      const names = new Set(traits.map(([n]) => n));
      for (const [name, tid] of manualTraitPairs(servantId, stage)) {
        if (!names.has(name)) {
          traits.push([name, tid]);
          names.add(name);
        }
      }
    }
    {
      const names = new Set(traits.map(([n]) => n));
      for (const [name, tid] of globalAdd) {
        if (!names.has(name)) {
          traits.push([name, tid]);
          names.add(name);
        }
      }
    }
    traits = applyAttributeOverride(traits, attributeAsc[ascKey]);
    traits.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    result.set(stage, traits);
  }
  return result;
}

/** 某从者所有灵衣状态的完整特性集合 */
export function resolveCostumeTraitSets(servant: any): Map<number, TraitPair[]> {
  const individuality = servant?.ascensionAdd?.individuality ?? {};
  const costumeMap = (individuality.costume ?? {}) as Record<string, any[]>;
  const attributeCostume = (servant?.ascensionAdd?.attribute?.costume ?? {}) as Record<string, any>;
  const baseTraits = traitPairs(servant?.traits ?? []);
  const globalAdd = globalTraitAddPairs(servant);
  const result = new Map<number, TraitPair[]>();
  for (const costumeId of Object.keys(costumeMap)) {
    const raw = costumeMap[costumeId] ?? [];
    let traits = traitPairs(raw);
    if (traits.length === 0) {
      // Atlas 空列表 = 这件灵衣不改特性 ⇒ 就是本体特性
      traits = baseTraits.map(([n, t]) => [n, t] as TraitPair);
    }
    const names = new Set(traits.map(([n]) => n));
    for (const [name, tid] of globalAdd) {
      if (!names.has(name)) {
        traits.push([name, tid]);
        names.add(name);
      }
    }
    traits = applyAttributeOverride(traits, attributeCostume[String(costumeId)]);
    if (traits.length > 0) {
      traits.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      result.set(parseInt(costumeId, 10), traits);
    }
  }
  return result;
}

export function parseServant(servant: any): Record<string, any> | null {
  if (!PLAYABLE_SERVANT_TYPES.has(servant?.type)) return null;
  const rawName = servant?.name ?? "";
  const rawOriginal = servant?.originalName ?? "";
  return {
    id: parseInt(String(servant["id"]), 10),
    collection_no: parseInt(String(servant?.collectionNo ?? 0), 10),
    name: translateJpName(rawName, "svt_names"),
    original_name: rawOriginal || rawName,
    class: servant?.className ?? "",
    cost: parseInt(String(servant?.cost ?? 0), 10),
    rarity: servant?.rarity ?? null,
    atk_max: servant?.atkMax ?? null,
    hp_max: servant?.hpMax ?? null,
    type: servant?.type ?? "",
  };
}

// ---------------------------------------------------------------------------
// 礼装解析
// ---------------------------------------------------------------------------
export function conditionGroups(func: any): string[][] {
  const groups: string[][] = [];
  const functvals = func?.functvals ?? [];
  if (functvals.length > 0) {
    for (const t of functvals) {
      if (t?.name && t.name !== "unknown") groups.push([String(t.name)]);
    }
    return groups;
  }
  let overwrite = func?.overWriteTvalsList ?? [];
  if (!overwrite || overwrite.length === 0) overwrite = func?.script?.overwriteTvals ?? [];
  for (const group of overwrite) {
    if (Array.isArray(group)) {
      const names: string[] = [];
      for (const t of group) if (t?.name && t.name !== "unknown") names.push(String(t.name));
      if (names.length > 0) groups.push(names);
    }
  }
  return groups;
}

export function rateFromSvals(func: any): [number, number] {
  let normal = 0;
  let follower = 0;
  const svals = func?.svals ?? [];
  if (svals.length > 0) normal = Number(svals[0]?.RateCount ?? 0) || 0;
  const followerVals = func?.followerVals ?? [];
  if (followerVals.length > 0) follower = Number(followerVals[0]?.RateCount ?? 0) || 0;
  return [normal, follower];
}

export function parseBondEffect(equip: any): Record<string, any> | null {
  let best: any = null;
  let bestNormalRate = -1;
  let bestSkillDetail = "";

  for (const skill of equip?.skills ?? []) {
    for (const func of skill?.functions ?? []) {
      if (func?.funcType !== "servantFriendshipUp") continue;
      const [normalRate, follower] = rateFromSvals(func);
      if (normalRate <= 0 && follower <= 0) continue;
      if (normalRate > bestNormalRate || best === null) {
        best = func;
        bestNormalRate = normalRate;
        bestSkillDetail = translateJpName(skill?.detail ?? "", "skill_detail");
      }
    }
  }
  if (best === null) return null;

  const [normalRate, followerRate] = rateFromSvals(best);
  const groups = conditionGroups(best);
  // RateCount 单位是 0.1%：20 -> 2% -> 0.02
  const normalBonus = normalRate / 1000.0;
  const followerBonus = followerRate / 1000.0;

  let bonusType: string;
  if (groups.length > 0) bonusType = "trait";
  else if (normalBonus <= 0 && followerBonus > 0) bonusType = "support_only";
  else bonusType = "universal";

  return {
    bonus_type: bonusType,
    bonus_value: normalBonus,
    support_bonus: followerBonus,
    trigger_traits_json: pyDumps(groups),
    detail: bestSkillDetail,
    is_bond_ce: 1,
  };
}

export function isEventLimitedDetail(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const low = detail.toLowerCase();
  return ["活动限定", "event only", "event limited", "イベント限定"].some((m) => low.includes(m));
}

export function parseCraft(equip: any): Record<string, any> | null {
  if (!CRAFT_EQUIP_TYPES.has(equip?.type)) return null;
  const effect = parseBondEffect(equip);
  const detail = effect ? effect["detail"] : null;
  const rawName = equip?.name ?? "";
  const rawOriginal = equip?.originalName ?? "";
  const base: Record<string, any> = {
    id: parseInt(String(equip["id"]), 10),
    collection_no: equip?.collectionNo ?? null,
    name: translateJpName(rawName, "ce_names"),
    original_name: rawOriginal || rawName,
    cost: parseInt(String(equip?.cost ?? 0), 10),
    rarity: equip?.rarity ?? null,
    bonus_type: null,
    bonus_value: null,
    support_bonus: null,
    trigger_traits_json: pyDumps([]),
    detail: detail,
    is_bond_ce: 0,
    is_event_limited: isEventLimitedDetail(detail) ? 1 : 0,
  };
  if (effect) Object.assign(base, effect);
  return base;
}

// ---------------------------------------------------------------------------
// 静态数据指纹 / 简中服差异
// ---------------------------------------------------------------------------
export function staticDataRevision(db: any): string {
  const parts: string[] = [];
  for (const table of [
    "servants",
    "servant_stage_traits",
    "servant_stage_traits_cn",
    "crafts",
    "servant_costumes",
    "servant_costume_traits",
    "servant_costume_traits_cn",
  ]) {
    let count = -1;
    try {
      const stmt = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`);
      try {
        if (stmt.step()) count = stmt.getAsObject()["c"] as number;
      } finally {
        stmt.free();
      }
    } catch {
      count = -1;
    }
    parts.push(`${table}=${count}`);
  }
  let updated = "";
  try {
    updated = getMeta(db, "updated_at") ?? "";
  } catch {
    updated = "";
  }
  parts.push(`updated_at=${updated}`);
  return parts.join("|");
}

function queryAll(db: any, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function cnUnavailableBondCeIds(db: any, cnEquips: any[]): number[] {
  const cnIds = new Set(cnEquips.map((e) => parseInt(String(e["id"]), 10)));
  const rows = queryAll(db, "SELECT id FROM crafts WHERE is_bond_ce = 1");
  return rows
    .map((r) => parseInt(String(r["id"]), 10))
    .filter((id) => !cnIds.has(id))
    .sort((a, b) => a - b);
}

export function cnUnavailableServantIds(db: any, cnServants: any[]): number[] {
  const cnIds = new Set<number>();
  for (const s of cnServants) {
    if (s?.id !== null && s?.id !== undefined && PLAYABLE_SERVANT_TYPES.has(s?.type)) {
      cnIds.add(parseInt(String(s["id"]), 10));
    }
  }
  const rows = queryAll(db, "SELECT id, type FROM servants");
  return rows
    .filter((r) => PLAYABLE_SERVANT_TYPES.has(r["type"]) && !cnIds.has(parseInt(String(r["id"]), 10)))
    .map((r) => parseInt(String(r["id"]), 10))
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 建库
// ---------------------------------------------------------------------------
export interface BuildOptions {
  region?: string | null;
  dbPath?: string | null;
  useCache?: boolean;
  progress?: ((message: string) => void) | null;
  /** 下载明细（每 2% 一行，含 MB/s 与剩余时间）。
   *  ⚠️ 默认只写宿主 stderr；界面要看到进度条就必须由调用方接走（worker 入口会转发给界面）。 */
  downloadLog?: ((message: string) => void) | null;
  /** 由调用方注入的 sql.js 工厂（默认从 node_modules 里找） */
  sqlFactory?: any;
}

export async function buildDatabase(opts: BuildOptions = {}): Promise<Record<string, any>> {
  const region = regionOrDefault(opts.region);
  const dbPath = opts.dbPath ?? dataCfg.dbPath;
  const useCache = opts.useCache ?? true;
  const progress = opts.progress ?? null;
  const downloadLog = opts.downloadLog ?? null;
  const db = await connectWrite(dbPath, opts.sqlFactory);
  initDb(db);
  // 整趟写库放进一个事务（sql.js 逐条 autocommit 慢得多）
  db.run("BEGIN");

  if (progress) progress("正在下载从者数据...");
  const servantsApi = await loadNiceServants(region, useCache, null, downloadLog ?? undefined);

  if (progress) progress("正在下载礼装数据...");
  const equipsApi = await loadNiceEquips(region, useCache, null, downloadLog ?? undefined);

  // 两份都拉成功后再清空旧数据，避免下载失败把本地可用库清掉
  clearDataTables(db);

  if (progress) progress("正在写入从者与特性数据...");

  let servantCount = 0;
  let stageTraitCount = 0;
  let craftCount = 0;
  let bondCeCount = 0;

  for (const raw of servantsApi) {
    const parsed = parseServant(raw);
    if (parsed === null) continue;
    upsertServant(db, parsed);
    servantCount += 1;
    for (const [stage, traits] of resolveStageTraitSets(raw)) {
      upsertStageTraits(db, parsed["id"], stage, traits);
      stageTraitCount += traits.length;
    }
    for (const [costumeId, traits] of resolveCostumeTraitSets(raw)) {
      upsertCostumeTraits(db, parsed["id"], costumeId, traits);
    }
  }

  // JP 全量作为主库时，额外写入简中服 traits（供日服/简中服切换后按服务器取数）
  let cnUnavailableServantIdsList: number[] = [];
  if (region !== "CN") {
    if (progress) progress("正在写入简中服特性数据...");
    try {
      const cnServantsApi = await loadNiceServants("CN", useCache, null, downloadLog ?? undefined);
      for (const raw of cnServantsApi) {
        const parsed = parseServant(raw);
        if (parsed === null) continue;
        for (const [stage, traits] of resolveStageTraitSets(raw)) {
          upsertStageTraitsCn(db, parsed["id"], stage, traits);
        }
        for (const [costumeId, traits] of resolveCostumeTraitSets(raw)) {
          upsertCostumeTraitsCn(db, parsed["id"], costumeId, traits);
        }
      }
      cnUnavailableServantIdsList = cnUnavailableServantIds(db, cnServantsApi);
      try {
        const meta = await getRemoteExportMeta("CN", NICE_SERVANT_FILE);
        setMeta(db, "cn_servant_etag", meta["etag"]);
      } catch {
        /* 记不上不影响主数据 */
      }
    } catch (exc: any) {
      if (progress) progress(`警告：无法写入简中服特性数据（${exc?.message ?? exc}）`);
    }
  }

  if (progress) progress("正在写入礼装数据...");
  for (const raw of equipsApi) {
    const parsed = parseCraft(raw);
    if (parsed === null) continue;
    upsertCraft(db, parsed);
    craftCount += 1;
    if (parsed["is_bond_ce"]) bondCeCount += 1;
  }

  // 简中服尚未实装的可选牵绊礼装 ID
  let cnUnavailableIds: number[] = [];
  const oldCnUnavailableRaw = getMeta(db, "cn_unavailable_bond_ce_ids");
  try {
    if (region === "CN") {
      cnUnavailableIds = [];
      setMeta(db, "cn_equip_etag", "");
    } else {
      // 简中服礼装只用 id 集合算"未实装"差集 → 用 basic 包（0.8MB），别再下 21MB 整包
      const cnEquips = await loadBasicEntries("CN", BASIC_EQUIP_FILE, useCache, downloadLog ?? undefined);
      cnUnavailableIds = cnUnavailableBondCeIds(db, cnEquips);
      try {
        const cnMeta = await getRemoteExportMeta("CN", NICE_EQUIP_FILE);
        setMeta(db, "cn_equip_etag", cnMeta["etag"]);
      } catch {
        /* 记不上不影响 */
      }
    }
  } catch (exc: any) {
    try {
      cnUnavailableIds = JSON.parse(oldCnUnavailableRaw || "[]");
    } catch {
      cnUnavailableIds = [];
    }
    if (progress) {
      progress(`警告：无法获取简中服礼装数据，暂用上次的国服未实装列表（${exc?.message ?? exc}）`);
    }
  }
  setMeta(db, "cn_unavailable_bond_ce_ids", pyDumps(cnUnavailableIds));

  // 简中服尚未实装的可玩从者（非 CN 区域构建时若这次没算出来，沿用上一次）
  if (region !== "CN" && cnUnavailableServantIdsList.length === 0) {
    try {
      const previous = JSON.parse(getMeta(db, "cn_unavailable_servant_ids") || "[]");
      if (Array.isArray(previous) && previous.length > 0) {
        cnUnavailableServantIdsList = previous.map((x: any) => parseInt(String(x), 10));
      }
    } catch {
      cnUnavailableServantIdsList = [];
    }
  }
  setMeta(db, "cn_unavailable_servant_ids", pyDumps(cnUnavailableServantIdsList));

  // 数据版本信息
  let remoteMeta: Record<string, string>;
  try {
    remoteMeta = await getRemoteExportMeta(region);
  } catch {
    remoteMeta = { etag: "", last_modified: "" };
  }

  setMeta(db, "data_region", region);
  setMeta(db, "servant_etag", remoteMeta["etag"]);
  setMeta(db, "servant_last_modified", remoteMeta["last_modified"]);
  setMeta(db, "updated_at", isoSeconds(new Date()));
  // 静态数据指纹：能识别"updated_at 没变但内容变了"
  try {
    setMeta(db, "static_revision", staticDataRevision(db));
  } catch (exc: any) {
    if (progress) progress(`警告：写入静态数据指纹失败（不影响本次更新）：${exc?.message ?? exc}`);
  }

  db.run("COMMIT");
  finalizeStatements(db);
  exportDb(db, dbPath);

  return {
    region,
    servants: servantCount,
    stage_trait_rows: stageTraitCount,
    crafts: craftCount,
    bond_ces: bondCeCount,
    cn_unavailable_bond_ces: cnUnavailableIds.length,
    cn_unavailable_servants: cnUnavailableServantIdsList.length,
  };
}

/** `datetime.now().isoformat(timespec="seconds")`（本地时间、无时区后缀） */
export function isoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// 灵衣名（官方 raw 单从者接口）
// ---------------------------------------------------------------------------
export const COSTUME_NAME_SOURCE = "https://api.atlasacademy.io/raw/{region}/servant/{id}";
const COSTUME_NAME_PREFIX = /^[^：:]{0,8}(?:灵衣|霊衣)[：:]/;

/** 库里已出现灵衣的 (servant_id, costume_id) 对；onlyMissing 只留还没名字的 */
export function costumeNamePairs(db: any, onlyMissing: boolean): [number, number][] {
  let sql =
    "SELECT DISTINCT t.servant_id, t.costume_id FROM servant_costume_traits t " +
    "LEFT JOIN servant_costumes c " +
    "ON c.servant_id = t.servant_id AND c.costume_id = t.costume_id";
  if (onlyMissing) sql += " WHERE c.name IS NULL OR TRIM(c.name) = ''";
  return queryAll(db, sql).map((r) => [
    parseInt(String(r["servant_id"]), 10),
    parseInt(String(r["costume_id"]), 10),
  ]);
}

export async function fetchCostumeNames(sid: number, region: string): Promise<[Map<number, string>, number]> {
  const url = COSTUME_NAME_SOURCE.replace("{region}", region).replace("{id}", String(sid));
  assertNet();
  const resp = await httpRequest(url, { headers: { "User-Agent": "FGOBondApp local" }, timeoutMs: 30 * 1000 });
  if (!resp.ok) throw new HttpError(resp.status, `HTTP ${resp.status}`);
  const buf = gunzipIfNeeded(await readAll(resp.body));
  const data = JSON.parse(Buffer.from(buf).toString("utf8"));
  const idMap = (data?.mstSvtExtra?.costumeLimitSvtIdMap ?? {}) as Record<string, any>;
  const names = new Map<number, string>();
  for (const ent of Object.values(idMap)) {
    if (!ent || typeof ent !== "object") continue;
    const cid = ent["battleCharaId"];
    let name = String(ent["name"] ?? ent["shortName"] ?? "").trim();
    if (!cid || !name) continue;
    name = name.replace(COSTUME_NAME_PREFIX, "").trim();
    if (name) names.set(parseInt(String(cid), 10), name);
  }
  return [names, buf.length];
}

export interface CostumeOptions {
  region?: string | null;
  dbPath?: string | null;
  progress?: ((message: string) => void) | null;
  onlyMissing?: boolean;
  nameRegion?: string;
  sqlFactory?: any;
}

export async function refreshCostumeNames(opts: CostumeOptions = {}): Promise<Record<string, any>> {
  const region = regionOrDefault(opts.region);
  const nameRegion = String(opts.nameRegion ?? region).toUpperCase();
  const dbPath = opts.dbPath ?? dataCfg.dbPath;
  const progress = opts.progress ?? null;
  const db = await connectWrite(dbPath, opts.sqlFactory);
  initDb(db);
  db.run("BEGIN");
  const pairs = costumeNamePairs(db, opts.onlyMissing ?? true);
  const pending = new Map<number, number[]>();
  for (const [sid, cid] of pairs) {
    const arr = pending.get(sid) ?? [];
    arr.push(cid);
    pending.set(sid, arr);
  }
  const servantIds = [...pending.keys()].sort((a, b) => a - b);

  let filled = 0;
  let errors = 0;
  let totalBytes = 0;
  let requests = 0;

  // 并发 4：灵衣名是"每个从者一次单条请求"，串行时 116 个 ≈ 3 分钟（走代理每次还要一次握手），
  // 实测并发 4 后整轮更新从 ~7 分钟降到 ~2.5 分钟。写库仍是主线程同步执行，不需要加锁。
  const COSTUME_CONCURRENCY = 4;
  const fill = async (reg: string, translate: boolean, label: string): Promise<void> => {
    const todoServants = [...pending.keys()].filter((sid) => (pending.get(sid) ?? []).length > 0).sort((a, b) => a - b);
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const sid = todoServants[next];
        next += 1;
        if (sid === undefined) return;
        requests += 1;
        let names: Map<number, string>;
        let nbytes: number;
        try {
          [names, nbytes] = await fetchCostumeNames(sid, reg);
          totalBytes += nbytes;
        } catch {
          errors += 1;
          done += 1;
          continue;
        }
        const still: number[] = [];
        for (const cid of pending.get(sid) ?? []) {
          let name = names.get(cid) ?? "";
          if (name && translate) {
            const cnName = translateJpName(name, "costume_names");
            // 译名表里没有对应中文 → 不留日文原名
            name = cnName === name ? "" : cnName;
          }
          if (name) {
            upsertCostumeName(db, sid, cid, name);
            filled += 1;
          } else {
            still.push(cid);
          }
        }
        pending.set(sid, still);
        done += 1;
        if (progress && done % 5 === 0) progress(`正在${label}灵衣名称 ${done}/${todoServants.length}...`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(COSTUME_CONCURRENCY, todoServants.length) }, worker));
    if (progress) progress(`正在${label}灵衣名称 ${todoServants.length}/${todoServants.length}...`);
  };

  await fill(nameRegion, false, "更新");
  await fill("JP", true, "补入");

  let stillMissing = 0;
  for (const v of pending.values()) stillMissing += v.length;

  db.run("COMMIT");
  finalizeStatements(db);
  exportDb(db, dbPath);
  return {
    costume_names: filled,
    costume_name_servants: servantIds.length,
    costume_name_bytes: totalBytes,
    costume_name_errors: errors,
    costume_name_requests: requests,
    costume_name_still_missing: stillMissing,
  };
}

// ---------------------------------------------------------------------------
// 检查更新 / 更新数据
// ---------------------------------------------------------------------------
async function safeRemoteMeta(reg: string, filename: string): Promise<Record<string, string>> {
  try {
    return await getRemoteExportMeta(reg, filename);
  } catch {
    return { etag: "", last_modified: "" };
  }
}

export async function checkUpdate(
  region: string | null = null,
  dbPath: string | null = null,
  sqlFactory?: any,
): Promise<Record<string, any>> {
  const r = regionOrDefault(region);
  const db = await connectWrite(dbPath ?? dataCfg.dbPath, sqlFactory);
  initDb(db);
  // ⚠️ 本地可能存着 Python 时代写下的、没有 `-gzip` 后缀的 ETag（见 normalizeEtag）
  const localEtag = normalizeEtag(getMeta(db, "servant_etag"));
  const localCnEquipEtag = normalizeEtag(getMeta(db, "cn_equip_etag"));
  const localCnServantEtag = normalizeEtag(getMeta(db, "cn_servant_etag"));
  const localEventEtag = normalizeEtag(getMeta(db, "event_etag"));
  const localUpdatedAt = getMeta(db, "updated_at") ?? "";
  exportDb(db, dbPath ?? dataCfg.dbPath);

  const jpMeta = await safeRemoteMeta(r, NICE_SERVANT_FILE);
  const reasons: string[] = [];
  if (jpMeta["etag"] && localEtag !== jpMeta["etag"]) reasons.push("日服数据有更新");
  if (r !== "CN") {
    const cnEquipMeta = await safeRemoteMeta("CN", NICE_EQUIP_FILE);
    const cnServantMeta = await safeRemoteMeta("CN", NICE_SERVANT_FILE);
    if (cnEquipMeta["etag"] && localCnEquipEtag !== cnEquipMeta["etag"]) reasons.push("简中服礼装有更新");
    if (cnServantMeta["etag"] && localCnServantEtag !== cnServantMeta["etag"]) reasons.push("简中服从者有更新");
  }
  const eventMeta = await safeRemoteMeta(r, NICE_EVENT_FILE);
  if (eventMeta["etag"] && localEventEtag !== eventMeta["etag"]) reasons.push("活动牵绊加成有更新");

  const available = reasons.length > 0;
  return {
    status: available ? "update_available" : "no_change",
    updated: false,
    update_available: available,
    region: r,
    local_etag: localEtag,
    remote_etag: jpMeta["etag"],
    remote_last_modified: jpMeta["last_modified"],
    local_updated_at: localUpdatedAt,
    reasons,
    message: available ? reasons.join("、") : "数据已经是最新版本",
  };
}

export interface UpdateOptions extends BuildOptions {
  /** 便捷注入：事件加成更新函数（由 eventBonus.ts 提供，避免循环依赖） */
  eventBonusUpdater?: ((o: any) => Promise<Record<string, any>>) | null;
}

export async function updateDatabase(opts: UpdateOptions = {}): Promise<Record<string, any>> {
  const region = regionOrDefault(opts.region);
  const progress = opts.progress ?? null;
  // 下载明细（每 2% 一行）走同一个 progress 通道：界面靠它画进度条，否则大文件下载期间界面纹丝不动
  const downloadLog = opts.downloadLog ?? (progress ? (m: string) => progress(m) : null);
  if (progress) progress("正在检查数据更新...");
  // 让界面知道这趟走的是代理还是直连（用户的网络环境千差万别，出问题时第一眼看这个）
  if (progress) progress(`网络：${proxyLabel(currentProxy())}`);
  const dbPath = opts.dbPath ?? dataCfg.dbPath;
  {
    const db = await connectWrite(dbPath, opts.sqlFactory);
    initDb(db);
    exportDb(db, dbPath);
  }

  const stats: Record<string, any> = await buildDatabase({
    region,
    dbPath,
    useCache: opts.useCache ?? true,
    progress,
    downloadLog,
    sqlFactory: opts.sqlFactory,
  });
  try {
    const nameStats = await refreshCostumeNames({
      region,
      dbPath,
      progress,
      sqlFactory: opts.sqlFactory,
    });
    Object.assign(stats, nameStats);
  } catch (e: any) {
    stats["costume_name_error"] = String(e?.message ?? e);
  }
  try {
    if (opts.eventBonusUpdater) {
      const eventStats = await opts.eventBonusUpdater({
        region,
        dbPath,
        useCache: opts.useCache ?? true,
        progress,
        downloadLog,
        sqlFactory: opts.sqlFactory,
      });
      Object.assign(stats, eventStats);
    }
  } catch (e: any) {
    stats["event_bonus_error"] = String(e?.message ?? e);
  }
  if (progress) progress("数据更新完成");
  stats["status"] = "success";
  stats["updated"] = true;
  return stats;
}
