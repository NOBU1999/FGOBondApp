"use strict";

/**
 * SQLite 数据访问层（Electron 主进程）
 *
 * 优先使用 better-sqlite3（若已安装并完成 Electron 原生模块重建）；
 * 否则退回 Node 内置 node:sqlite（DatabaseSync），便于开发期直接运行。
 * 所有用户数据/本地数据都存放在 db/fgo_data.db。
 */

const fs = require("fs");
const path = require("path");
const { getDbPath } = require("./paths");
const { createDomain } = require("../shared/domain/index.mjs");

let BetterSqlite3 = null;
try {
  BetterSqlite3 = require("better-sqlite3");
} catch (_) {
  BetterSqlite3 = null;
}

let NodeSqlite = null;
try {
  NodeSqlite = require("node:sqlite");
} catch (_) {
  NodeSqlite = null;
}


// ---------------------------------------------------------------------------
// 共用领域层接入（阶段 1）
//   逻辑已搬进 shared/domain/，这里只保留「平台适配」：
//   把 SQLite 驱动包装成共用层使用的 sql 端口（契约见 shared/storage/sql-port.md）
// ---------------------------------------------------------------------------
/** 平台能力：base64 → UTF-8 文本（与旧实现逐字节一致；将来浏览器版换成 atob + TextDecoder） */
const platformCodec = {
  decodeBase64ToUtf8(text) {
    return Buffer.from(text, "base64").toString("utf8");
  },
};

function createSqlPort(db) {
  return {
    all(sqlText, params = []) {
      return db
        .prepare(sqlText)
        .all(...params)
        .map((row) => ({ ...row }));
    },
    get(sqlText, params = []) {
      return db.prepare(sqlText).get(...params);
    },
    run(sqlText, params = []) {
      const info = db.prepare(sqlText).run(...params);
      // 与旧版 run() 助手保持一致：稳定返回普通数字，避免驱动差异（BigInt）泄漏进共用层
      return { changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) };
    },
    exec(sqlText) {
      db.exec(sqlText);
    },
    tx(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (_) {
          /* ignore */
        }
        throw err;
      }
    },
  };
}

const domainCache = new WeakMap();

/** 一个数据库句柄对应一套领域层（构建一次后复用） */
function getDomain(db) {
  let domain = domainCache.get(db);
  if (!domain) {
    domain = createDomain({ sql: createSqlPort(db), codec: platformCodec });
    domainCache.set(db, domain);
  }
  return domain;
}

function open(dbPath) {
  const target = dbPath || getDbPath();
  if (BetterSqlite3) {
    const db = new BetterSqlite3(target);
    try {
      db.pragma("journal_mode = WAL");
    } catch (err) {
      // 打不开（例如文件损坏）时必须释放句柄，否则文件会被锁住无法替换
      try { db.close(); } catch (_) { /* ignore */ }
      throw err;
    }
    return db;
  }
  if (NodeSqlite) {
    const db = new NodeSqlite.DatabaseSync(target);
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch (err) {
      try { db.close(); } catch (_) { /* ignore */ }
      throw err;
    }
    return db;
  }
  throw new Error("未找到可用的 SQLite 驱动：请安装 better-sqlite3 或使用新版 Node/Electron");
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS servant_costumes (
      servant_id INTEGER NOT NULL,
      costume_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (servant_id, costume_id)
    );
    CREATE TABLE IF NOT EXISTS servant_stage_traits_cn (
      servant_id INTEGER NOT NULL,
      stage TEXT NOT NULL,
      trait TEXT NOT NULL,
      trait_id INTEGER,
      PRIMARY KEY (servant_id, stage, trait)
    );
    CREATE TABLE IF NOT EXISTS servant_costume_traits_cn (
      servant_id INTEGER NOT NULL,
      costume_id INTEGER NOT NULL,
      trait TEXT NOT NULL,
      trait_id INTEGER,
      PRIMARY KEY (servant_id, costume_id, trait)
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN quality_mode TEXT DEFAULT 'balanced'");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN support_position TEXT DEFAULT 'front_right'");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN support_second_craft_id INTEGER");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN mode TEXT DEFAULT 'normal'");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN crown_class TEXT DEFAULT 'all'");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN crown_positions TEXT");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_teams ADD COLUMN base_bond REAL DEFAULT 0");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_box ADD COLUMN aura_bonus REAL DEFAULT 0");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_box ADD COLUMN bond_rank INTEGER DEFAULT 0");
  } catch (_) {
    // 列已存在
  }
  try {
    db.exec("ALTER TABLE user_box ADD COLUMN bond_max_rank INTEGER DEFAULT 0");
  } catch (_) {
    // 列已存在
  }
  ensureAccountSchema(db);
}

// ---------------------------------------------------------------------------
// 多账号：一个账号 = 一套 Box + 一套排除列表
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 账号（逻辑在 shared/domain/accounts.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function ensureAccountSchema(db) {
  return getDomain(db).accounts.ensureAccountSchema();
}

function resolveAccountId(db, accountId, options = {}) {
  return getDomain(db).accounts.resolveAccountId(accountId, options);
}

function getActiveAccountId(db) {
  return getDomain(db).accounts.getActiveAccountId();
}

function getActiveAccount(db) {
  return getDomain(db).accounts.getActiveAccount();
}

function listAccounts(db) {
  return getDomain(db).accounts.listAccounts();
}

function copyAccountData(db, fromId, toId) {
  return getDomain(db).accounts.copyAccountData(fromId, toId);
}

function createAccount(db, name, options = {}) {
  return getDomain(db).accounts.createAccount(name, options);
}

function renameAccount(db, id, name) {
  return getDomain(db).accounts.renameAccount(id, name);
}

function duplicateAccount(db, id, name) {
  return getDomain(db).accounts.duplicateAccount(id, name);
}

function deleteAccount(db, id) {
  return getDomain(db).accounts.deleteAccount(id);
}

function setActiveAccount(db, id) {
  return getDomain(db).accounts.setActiveAccount(id);
}

function all(db, sql, params = []) {
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => ({ ...r }));
}

function get(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : undefined;
}

function run(db, sql, params = []) {
  const info = db.prepare(sql).run(...params);
  return { changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) };
}

// ---------------------------------------------------------------------------
// 静态数据查询（逻辑在 shared/domain/static-data.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function listServants(db, region) {
  return getDomain(db).staticData.listServants(region);
}

function getCostumeNames(db) {
  return getDomain(db).staticData.getCostumeNames();
}

function getServant(db, servantId) {
  return getDomain(db).staticData.getServant(servantId);
}

function getStageTraits(db, servantId, stage, region) {
  return getDomain(db).staticData.getStageTraits(servantId, stage, region);
}

function getAllStageTraits(db, servantId, region) {
  return getDomain(db).staticData.getAllStageTraits(servantId, region);
}

function listCrafts(db, bondOnly = false) {
  return getDomain(db).staticData.listCrafts(bondOnly);
}

// ---------------------------------------------------------------------------
// 用户 Box / 排除名单（逻辑在 shared/domain/box.mjs、exclusions.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function getUserBox(db, accountId) {
  return getDomain(db).box.getUserBox(accountId);
}

function saveUserBox(db, entries, accountId) {
  return getDomain(db).box.saveUserBox(entries, accountId);
}

function resetUserBox(db, accountId) {
  return getDomain(db).box.resetUserBox(accountId);
}

function importCaptureContent(db, content, accountId) {
  return getDomain(db).box.importCaptureContent(content, accountId);
}

function getExclusions(db, accountId) {
  return getDomain(db).exclusions.getExclusions(accountId);
}

function saveExclusions(db, exclusions, accountId) {
  return getDomain(db).exclusions.saveExclusions(exclusions, accountId);
}

// ---------------------------------------------------------------------------
// meta / 设置（逻辑在 shared/domain/meta.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function getMetaValue(db, key) {
  return getDomain(db).meta.getMetaValue(key);
}

function setMetaValue(db, key, value) {
  return getDomain(db).meta.setMetaValue(key, value);
}

function getCnUnavailableBondCeIds(db) {
  return getDomain(db).meta.getCnUnavailableBondCeIds();
}

function getServerRegion(db) {
  return getDomain(db).meta.getServerRegion();
}

function setServerRegion(db, region) {
  return getDomain(db).meta.setServerRegion(region);
}

function getGenericBondParticipation(db) {
  return getDomain(db).meta.getGenericBondParticipation();
}

function setGenericBondParticipation(db, ids) {
  return getDomain(db).meta.setGenericBondParticipation(ids);
}

function getNonParticipatingCraftIds(db) {
  return getDomain(db).meta.getNonParticipatingCraftIds();
}

function setNonParticipatingCraftIds(db, ids) {
  return getDomain(db).meta.setNonParticipatingCraftIds(ids);
}

// ---------------------------------------------------------------------------
// 自定义礼装（逻辑在 shared/domain/custom-crafts.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function listCustomCrafts(db) {
  return getDomain(db).customCrafts.listCustomCrafts();
}

function saveCustomCrafts(db, items) {
  return getDomain(db).customCrafts.saveCustomCrafts(items);
}

// ---------------------------------------------------------------------------
// 队伍预设（逻辑在 shared/domain/teams.mjs，这里只做转发）
// ---------------------------------------------------------------------------
function saveUserTeam(db, team) {
  return getDomain(db).teams.saveUserTeam(team);
}

function listUserTeams(db) {
  return getDomain(db).teams.listUserTeams();
}

function deleteUserTeam(db, id) {
  return getDomain(db).teams.deleteUserTeam(id);
}

function getEventBondBonuses(dbPath) {
  const dir = path.dirname(dbPath || getDbPath());
  const file = path.join(dir, "event_bond_bonus.json");
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return [];
  }
}

module.exports = {
  open,
  ensureSchema,
  all,
  get,
  run,
  listServants,
  getServant,
  getCostumeNames,
  getStageTraits,
  getAllStageTraits,
  listCrafts,
  getUserBox,
  saveUserBox,
  resetUserBox,
  importCaptureContent,
  ensureAccountSchema,
  listAccounts,
  getActiveAccount,
  getActiveAccountId,
  createAccount,
  renameAccount,
  duplicateAccount,
  deleteAccount,
  setActiveAccount,
  copyAccountData,
  saveUserTeam,
  listUserTeams,
  deleteUserTeam,
  getExclusions,
  saveExclusions,
  getMetaValue,
  setMetaValue,
  getCnUnavailableBondCeIds,
  getServerRegion,
  setServerRegion,
  getGenericBondParticipation,
  setGenericBondParticipation,
  getNonParticipatingCraftIds,
  setNonParticipatingCraftIds,
  listCustomCrafts,
  saveCustomCrafts,
  getEventBondBonuses,
};
