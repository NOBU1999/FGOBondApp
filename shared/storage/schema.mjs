/**
 * 存储层结构定义（**唯一来源**）
 *
 * v0.3.8 起数据库拆成两个文件：
 *   - `db/game.db`       游戏静态数据（从者 / 礼装 / 特性 / 灵衣 / 柱子战冻结表）
 *                        随包发布，**只读**；每次装新版整份替换（用户「更新数据」会重写它）
 *   - `db/fgo_data.db`   个人数据（账号 / Box / 排除 / 冠位名单 / 预设 / 自定义礼装 / 个人设置）
 *                        不进发布包，升级永远不碰，导出/导入就是这一个文件
 *
 * 读写口径
 * --------
 * 运行时把个人库当 **主库** 打开，再把 `game.db` 以 `game` 为名 ATTACH 上来，
 * 给每张静态表建一个 **TEMP VIEW**（同名）⇒ 所有既有 SQL（`FROM servants` 之类）一行都不用改，
 * 但读到的永远是随包那份，个人库里再残留静态表也遮蔽掉。
 * `app_meta` 也是视图：个人库优先，静态键从 `game.db` 补。
 * 写 `app_meta` 时必须显式写 `main.app_meta`（视图不可写）。
 *
 * 这个文件同时被 CJS（main/、scripts/）和 ESM（platforms/android/web-host/boot.js）使用，
 * 所以用 .mjs 且不依赖任何 Node API（Node 22+ 的 require(esm) 与浏览器的动态 import 都能加载）。
 */

/** 运行时个人库文件名 */
export const PERSONAL_DB_NAME = "fgo_data.db";
/** 随包静态库文件名 */
export const GAME_DB_NAME = "game.db";
/** 老版本（<=0.3.7）单库模式的种子库文件名：只用于升级时识别旧布局 */
export const LEGACY_SEED_NAME = "fgo_data.seed.db";

/** ATTACH 前缀：`game.servants` */
export const GAME_SCHEMA = "game";

/**
 * 静态数据表（有依赖顺序：清空/重建时从下往上删）。
 * 必须与 engine-ts/src/databaseWrite.ts 的 STATIC_DATA_TABLES（前 7 张）一致。
 */
export const STATIC_TABLES = [
  "servant_costume_traits_cn",
  "servant_costume_traits",
  "servant_stage_traits_cn",
  "servant_stage_traits",
  "servant_costumes",
  "servants",
  "crafts",
  // 终章柱子战的冻结特性表：跟着活动走、内容永久固定，属于静态数据
  "pillar_costume_traits",
  "pillar_stage_traits",
];

/**
 * 属于「游戏数据」的 app_meta 键：随包 / 由「更新数据」写入 `game.db`。
 * 升级时这些键若残留在个人库里会让同名视图读回旧值（个人优先），所以迁移时要删掉。
 */
export const STATIC_META_KEYS = [
  "updated_at",
  "static_revision",
  "static_align_version",
  "data_region",
  "schema_version",
  "servant_etag",
  "servant_last_modified",
  "cn_servant_etag",
  "cn_equip_etag",
  "event_etag",
  "cn_unavailable_bond_ce_ids",
  "cn_unavailable_servant_ids",
];

/** 个人数据表（导出 / 导入 / 备份的单位） */
export const USER_TABLES = [
  "accounts",
  "user_box",
  "user_exclusions",
  "user_crown_servants",
  "user_teams",
  "saved_results",
  "custom_crafts",
];

/** 个人设置：保存在个人库的 app_meta 里 */
export const USER_META_KEYS = [
  "active_account_id",
  "server_region",
  "generic_bond_participation",
  "non_participating_craft_ids",
];

/** 个人库的表结构（静态表一概不建：它们只存在于 game.db） */
export const PERSONAL_DDL = `
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL DEFAULT 1,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    UNIQUE(account_id, target_type, target_id)
  );
  CREATE TABLE IF NOT EXISTS user_crown_servants (
    account_id INTEGER NOT NULL DEFAULT 1,
    servant_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, servant_id)
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
  CREATE TABLE IF NOT EXISTS user_box (
    account_id INTEGER NOT NULL DEFAULT 1,
    servant_id INTEGER NOT NULL,
    stage TEXT DEFAULT 'fourth',
    is_max_bond INTEGER DEFAULT 0,
    bond_switch1 INTEGER DEFAULT 1,
    bond_switch2 INTEGER DEFAULT 0,
    personal_bonus REAL DEFAULT 0,
    aura_bonus REAL DEFAULT 0,
    bond_rank INTEGER DEFAULT 0,
    bond_max_rank INTEGER DEFAULT 0,
    cost_override INTEGER DEFAULT NULL,
    PRIMARY KEY (account_id, servant_id)
  );
  CREATE TABLE IF NOT EXISTS user_teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    fixed_servants TEXT,
    fixed_crafts TEXT,
    support_id INTEGER,
    support_craft_id INTEGER,
    support_second_craft_id INTEGER,
    support_position TEXT DEFAULT 'front_right',
    cost_limit INTEGER DEFAULT 114,
    strategy TEXT DEFAULT 'total_max',
    quality_mode TEXT DEFAULT 'balanced',
    mode TEXT DEFAULT 'normal',
    crown_class TEXT DEFAULT 'all',
    crown_positions TEXT,
    base_bond REAL DEFAULT 0,
    neighborhood TEXT DEFAULT 'standard',
    search_order TEXT DEFAULT 'servant',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    result_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS saved_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER,
    data_revision TEXT,
    request_json TEXT,
    result_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

/**
 * 老个人库缺列时的补列语句（列已存在会报错，调用方逐条 ignore）。
 * 安卓 boot.js 与桌面 main/database.js 共用这一份，别再各写一套。
 */
export const PERSONAL_ALTERS = [
  "ALTER TABLE user_teams ADD COLUMN quality_mode TEXT DEFAULT 'balanced'",
  "ALTER TABLE user_teams ADD COLUMN neighborhood TEXT DEFAULT 'standard'",
  "ALTER TABLE user_teams ADD COLUMN search_order TEXT DEFAULT 'servant'",
  "ALTER TABLE user_teams ADD COLUMN support_position TEXT DEFAULT 'front_right'",
  "ALTER TABLE user_teams ADD COLUMN support_second_craft_id INTEGER",
  "ALTER TABLE user_teams ADD COLUMN mode TEXT DEFAULT 'normal'",
  "ALTER TABLE user_teams ADD COLUMN crown_class TEXT DEFAULT 'all'",
  "ALTER TABLE user_teams ADD COLUMN crown_positions TEXT",
  "ALTER TABLE user_teams ADD COLUMN base_bond REAL DEFAULT 0",
  "ALTER TABLE user_teams ADD COLUMN result_id INTEGER",
  "ALTER TABLE user_box ADD COLUMN aura_bonus REAL DEFAULT 0",
  "ALTER TABLE user_box ADD COLUMN bond_rank INTEGER DEFAULT 0",
  "ALTER TABLE user_box ADD COLUMN bond_max_rank INTEGER DEFAULT 0",
  "ALTER TABLE user_box ADD COLUMN cost_override INTEGER DEFAULT NULL",
];

/** 静态表存在时，为它建同名临时视图（不存在就跳过，兼容老 game.db） */
export function staticViewSql(table) {
  return `CREATE TEMP VIEW "${table}" AS SELECT * FROM ${GAME_SCHEMA}."${table}"`;
}

/**
 * app_meta 合并视图：个人库优先，静态键从 game.db 补。
 * 注意：这是**视图**，写入必须显式 `main.app_meta`（见 shared/domain/meta.mjs）。
 */
export const META_VIEW_SQL = `CREATE TEMP VIEW app_meta AS
  SELECT key, value FROM main.app_meta
  UNION ALL
  SELECT key, value FROM ${GAME_SCHEMA}.app_meta
  WHERE key NOT IN (SELECT key FROM main.app_meta)`;
