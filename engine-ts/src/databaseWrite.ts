// P3.5：SQLite **写侧**（对齐 database.py 的 DDL / init_db / clear_data_tables /
// upsert_* / get_meta / set_meta / static_data_revision 依赖的查询）。
//
// 读侧在 `database.ts`（那边只读、不建表）；这里给「更新数据」用。
// sql.js 是内存库：调用方最后用 `exportDb(conn)` 落盘。
import fs from "node:fs";
import path from "node:path";
import { getPlatform } from "./platform.ts";

/** 与 Python `database.DDL` 逐字一致（注意 crafts 的两列注释与 NOT NULL） */
export const DDL = `
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servants (
    id INTEGER PRIMARY KEY,
    collection_no INTEGER NOT NULL,
    name TEXT NOT NULL,
    original_name TEXT,
    class TEXT NOT NULL,
    cost INTEGER NOT NULL,
    rarity INTEGER,
    atk_max INTEGER,
    hp_max INTEGER,
    type TEXT
);

CREATE TABLE IF NOT EXISTS servant_stage_traits (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    stage TEXT NOT NULL CHECK(stage IN ('initial','first','second','third','fourth')),
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, stage, trait)
);
CREATE INDEX IF NOT EXISTS idx_stage_traits_stage_trait
    ON servant_stage_traits(stage, trait);

CREATE TABLE IF NOT EXISTS servant_costume_traits (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    costume_id INTEGER NOT NULL,
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, costume_id, trait)
);
CREATE INDEX IF NOT EXISTS idx_costume_traits_costume
    ON servant_costume_traits(costume_id, trait);

CREATE TABLE IF NOT EXISTS servant_costumes (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    costume_id INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (servant_id, costume_id)
);

CREATE TABLE IF NOT EXISTS servant_stage_traits_cn (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    stage TEXT NOT NULL CHECK(stage IN ('initial','first','second','third','fourth')),
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, stage, trait)
);
CREATE INDEX IF NOT EXISTS idx_stage_traits_cn_stage_trait
    ON servant_stage_traits_cn(stage, trait);

CREATE TABLE IF NOT EXISTS servant_costume_traits_cn (
    servant_id INTEGER NOT NULL REFERENCES servants(id),
    costume_id INTEGER NOT NULL,
    trait TEXT NOT NULL,
    trait_id INTEGER,
    PRIMARY KEY (servant_id, costume_id, trait)
);
CREATE INDEX IF NOT EXISTS idx_costume_traits_cn_costume
    ON servant_costume_traits_cn(costume_id, trait);

CREATE TABLE IF NOT EXISTS crafts (
    id INTEGER PRIMARY KEY,
    collection_no INTEGER,
    name TEXT NOT NULL,
    original_name TEXT,
    cost INTEGER NOT NULL,
    rarity INTEGER,
    bonus_type TEXT,
    bonus_value REAL,
    support_bonus REAL,
    trigger_traits_json TEXT,
    detail TEXT,
    is_bond_ce INTEGER NOT NULL DEFAULT 0,
    is_event_limited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_box (
    servant_id INTEGER PRIMARY KEY,
    stage TEXT DEFAULT 'fourth',
    is_max_bond INTEGER DEFAULT 0,
    bond_switch1 INTEGER DEFAULT 1,
    bond_switch2 INTEGER DEFAULT 0,
    personal_bonus REAL DEFAULT 0,
    aura_bonus REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    fixed_servants TEXT,
    fixed_crafts TEXT,
    support_id INTEGER,
    support_craft_id INTEGER,
    cost_limit INTEGER DEFAULT 114,
    strategy TEXT DEFAULT 'total_max',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS custom_crafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    craft_type TEXT NOT NULL DEFAULT 'bond',
    cost INTEGER NOT NULL DEFAULT 0,
    rarity INTEGER NOT NULL DEFAULT 0,
    percent_bonus REAL NOT NULL DEFAULT 0,
    flat_bonus REAL NOT NULL DEFAULT 0,
    condition_groups_json TEXT NOT NULL DEFAULT '[]',
    repeatable INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const STAGES = ["initial", "first", "second", "third", "fourth"] as const;
export const SCHEMA_VERSION = 1;

/** 静态数据表（与 Python `STATIC_DATA_TABLES` 同序） */
export const STATIC_DATA_TABLES = [
  "servants",
  "servant_stage_traits",
  "servant_stage_traits_cn",
  "crafts",
  "servant_costumes",
  "servant_costume_traits",
  "servant_costume_traits_cn",
] as const;

let SQL_MODULE: any = null;

/** 初始化 sql.js（异步，只做一次）。
 *
 *  ⚠️ 必须走**平台层**，不能像以前那样直接 `require("sql.js")`：
 *     打包版里没有 `node_modules`，那样写会让「检查更新 / 更新数据」一按下去就抛
 *     `Cannot find module 'sql.js'`（v0.3.2 玩家报的就是这个，2026-10-28 在本机复现）。
 *     读库那条路（`database.ts`）本来就走平台层，所以主界面一直是好的，
 *     只有写库这条（更新数据）坏 —— 两条路必须共用同一个加载器。
 *     平台层按 `dist\engine-ts\` → `resources\sqljs\` → `sqljs\`（随包备用副本）成对找
 *     `sql-wasm.js` + `sql-wasm.wasm`，与 `node_modules` 无关。 */
export async function initSql(appRoot?: string): Promise<any> {
  if (SQL_MODULE) return SQL_MODULE;
  SQL_MODULE = await getPlatform().loadSqlJs(appRoot ? { appRoot } : {});
  return SQL_MODULE;
}

/** 打开（或新建）一个库，返回 sql.js Database。 */
export async function connectWrite(dbPath: string, sqlFactory?: any): Promise<any> {
  const factory = sqlFactory ?? (await initSql());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) {
    const bytes = fs.readFileSync(dbPath);
    return new factory.Database(new Uint8Array(bytes));
  }
  return new factory.Database();
}

export function exportDb(db: any, dbPath: string): void {
  const data: Uint8Array = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function initDb(db: any, schemaVersion = SCHEMA_VERSION): void {
  db.exec(DDL);
  // 轻量迁移：给已存在库补列（列已存在时 sqlite 报错，忽略即可）
  try {
    db.run("ALTER TABLE crafts ADD COLUMN is_event_limited INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* 列已存在 */
  }
  try {
    db.run("ALTER TABLE user_box ADD COLUMN aura_bonus REAL DEFAULT 0");
  } catch {
    /* 列已存在 */
  }
  setMeta(db, "schema_version", String(schemaVersion));
}

export function clearDataTables(db: any): void {
  // ⚠️ 故意不清 `servant_costumes`：那张表只存"灵衣名"（servant_id, costume_id, name），
  //    名字不在 Atlas 导出里，只能一条条去 raw 单从者接口取。以前每轮更新都清掉 →
  //    每次都要重新请求 116 次（约 110 次多余请求/轮）；留下旧名字后只有**新增灵衣**才会补取。
  for (const t of [
    "servant_costume_traits",
    "servant_costume_traits_cn",
    "servant_stage_traits",
    "servant_stage_traits_cn",
    "servants",
    "crafts",
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
}

const STMT_CACHE = new WeakMap<any, Map<string, any>>();

/** 预编译语句复用：同一个 SQL 只 prepare 一次（sql.js 的 db.run 每次都 prepare+free） */
function stmtFor(db: any, sql: string): any {
  let m = STMT_CACHE.get(db);
  if (!m) {
    m = new Map();
    STMT_CACHE.set(db, m);
  }
  let st = m.get(sql);
  if (!st) {
    st = db.prepare(sql);
    m.set(sql, st);
  }
  return st;
}

/** 用完把语句全释放（sql.js 的 Statement 不 free 会留引用） */
export function finalizeStatements(db: any): void {
  const m = STMT_CACHE.get(db);
  if (!m) return;
  for (const st of m.values()) {
    try {
      st.free();
    } catch {
      /* 已释放 */
    }
  }
  m.clear();
}

/** 包一层事务：整体 BEGIN/COMMIT（失败 ROLLBACK） */
export function withTransaction<T>(db: any, fn: () => T): T {
  db.run("BEGIN");
  try {
    const out = fn();
    db.run("COMMIT");
    return out;
  } catch (exc) {
    try {
      db.run("ROLLBACK");
    } catch {
      /* 已经回滚 */
    }
    throw exc;
  }
}

export function getMeta(db: any, key: string): string | null {
  const stmt = db.prepare("SELECT value FROM app_meta WHERE key = ?");
  try {
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      return row["value"] ?? null;
    }
    return null;
  } finally {
    stmt.free();
  }
}

export function setMeta(db: any, key: string, value: string): void {
  stmtFor(db, "INSERT OR REPLACE INTO app_meta(key, value) VALUES(?, ?)").run([key, value]);
}

export function upsertServant(db: any, servant: Record<string, any>): void {
  stmtFor(
    db,
    `INSERT INTO servants
        (id, collection_no, name, original_name, class, cost,
         rarity, atk_max, hp_max, type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        collection_no=excluded.collection_no,
        name=excluded.name,
        original_name=excluded.original_name,
        class=excluded.class,
        cost=excluded.cost,
        rarity=excluded.rarity,
        atk_max=excluded.atk_max,
        hp_max=excluded.hp_max,
        type=excluded.type`,
  ).run([
    servant.id,
    servant.collection_no,
    servant.name,
    servant.original_name,
    servant.class,
    servant.cost,
    servant.rarity,
    servant.atk_max,
    servant.hp_max,
    servant.type,
  ]);
}

type TraitPair = [string, number | null];

function insertTraitRows(
  db: any,
  table: string,
  extraCols: string[],
  extraVals: any[],
  traits: TraitPair[],
): void {
  if (traits.length === 0) return;
  const cols = [...extraCols, "trait", "trait_id"];
  const placeholders = cols.map(() => "?").join(", ");
  const sql = `INSERT OR IGNORE INTO ${table}(${cols.join(", ")}) VALUES (${placeholders})`;
  const st = stmtFor(db, sql);
  for (const [trait, traitId] of traits) {
    st.run([...extraVals, trait, traitId]);
  }
}

export function upsertStageTraits(db: any, servantId: number, stage: string, traits: TraitPair[]): void {
  const s = stage.toLowerCase();
  if (!(STAGES as readonly string[]).includes(s)) throw new Error(`unknown stage: ${s}`);
  stmtFor(db, "DELETE FROM servant_stage_traits WHERE servant_id=? AND stage=?").run([servantId, s]);
  insertTraitRows(db, "servant_stage_traits", ["servant_id", "stage"], [servantId, s], traits);
}

export function upsertCostumeTraits(
  db: any,
  servantId: number,
  costumeId: number,
  traits: TraitPair[],
): void {
  stmtFor(db, "DELETE FROM servant_costume_traits WHERE servant_id=? AND costume_id=?").run([
    servantId,
    costumeId,
  ]);
  insertTraitRows(db, "servant_costume_traits", ["servant_id", "costume_id"], [servantId, costumeId], traits);
}

export function upsertStageTraitsCn(db: any, servantId: number, stage: string, traits: TraitPair[]): void {
  const s = stage.toLowerCase();
  if (!(STAGES as readonly string[]).includes(s)) throw new Error(`unknown stage: ${s}`);
  stmtFor(db, "DELETE FROM servant_stage_traits_cn WHERE servant_id=? AND stage=?").run([servantId, s]);
  insertTraitRows(db, "servant_stage_traits_cn", ["servant_id", "stage"], [servantId, s], traits);
}

export function upsertCostumeTraitsCn(
  db: any,
  servantId: number,
  costumeId: number,
  traits: TraitPair[],
): void {
  stmtFor(db, "DELETE FROM servant_costume_traits_cn WHERE servant_id=? AND costume_id=?").run([
    servantId,
    costumeId,
  ]);
  insertTraitRows(
    db,
    "servant_costume_traits_cn",
    ["servant_id", "costume_id"],
    [servantId, costumeId],
    traits,
  );
}

export function upsertCostumeName(db: any, servantId: number, costumeId: number, name: string): void {
  stmtFor(
    db,
    `INSERT INTO servant_costumes(servant_id, costume_id, name)
     VALUES (?, ?, ?)
     ON CONFLICT(servant_id, costume_id) DO UPDATE SET name=excluded.name`,
  ).run([servantId, costumeId, name || ""]);
}

export function upsertCraft(db: any, craft: Record<string, any>): void {
  stmtFor(
    db,
    `INSERT INTO crafts
        (id, collection_no, name, original_name, cost, rarity,
         bonus_type, bonus_value, support_bonus, trigger_traits_json,
         detail, is_bond_ce, is_event_limited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
        collection_no=excluded.collection_no,
        name=excluded.name,
        original_name=excluded.original_name,
        cost=excluded.cost,
        rarity=excluded.rarity,
        bonus_type=excluded.bonus_type,
        bonus_value=excluded.bonus_value,
        support_bonus=excluded.support_bonus,
        trigger_traits_json=excluded.trigger_traits_json,
        detail=excluded.detail,
        is_bond_ce=excluded.is_bond_ce,
        is_event_limited=excluded.is_event_limited`,
  ).run([
      craft.id,
      craft.collection_no,
      craft.name,
      craft.original_name,
      craft.cost,
      craft.rarity,
      craft.bonus_type,
      craft.bonus_value,
      craft.support_bonus,
      craft.trigger_traits_json,
      craft.detail,
      craft.is_bond_ce,
    craft.is_event_limited,
  ]);
}
