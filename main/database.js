"use strict";

/**
 * SQLite 数据访问层（Electron 主进程）
 *
 * 优先使用 better-sqlite3（若已安装并完成 Electron 原生模块重建）；
 * 否则退回 Node 内置 node:sqlite（DatabaseSync），便于开发期直接运行。
 *
 * v0.3.8 起两个库（见 shared/storage/schema.mjs 的文件头）：
 *   主库 = `db/fgo_data.db`（个人数据，可写）
 *   挂载 = `db/game.db`（随包静态数据，只读）→ 每张静态表在临时库里建同名视图
 * 于是「静态表读 game、个人表读主库」对上层完全透明，既有 SQL 一行不改。
 */

const fs = require("fs");
const path = require("path");
const { getDbPath } = require("./paths");
const { createDomain } = require("../shared/domain/index.mjs");
const {
  GAME_DB_NAME,
  GAME_SCHEMA,
  META_VIEW_SQL,
  PERSONAL_ALTERS,
  PERSONAL_DDL,
  STATIC_TABLES,
  staticViewSql,
} = require("../shared/storage/schema.mjs");

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

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 把随包的 `game.db` 挂到当前连接上，并给静态表建同名临时视图。
 * 挂不上（缺文件 / 文件坏了）时只警告，不抛：界面会退化成"没有静态数据"，
 * 但个人数据（Box / 预设）仍然读得出，用户至少能看到自己存的东西。
 */
function attachGame(db, gamePath) {
  if (!gamePath || !fs.existsSync(gamePath)) {
    console.warn(`[database] 找不到静态数据库 ${gamePath}（数据界面会是空的，请重新安装或更新数据）`);
    return false;
  }
  try {
    db.exec(`ATTACH DATABASE ${quoteSql(gamePath)} AS ${GAME_SCHEMA}`);
  } catch (err) {
    console.warn(`[database] 挂载静态数据库失败：${(err && err.message) || err}`);
    return false;
  }
  let hasTable = null;
  try {
    hasTable = db.prepare(
      `SELECT name FROM ${GAME_SCHEMA}.sqlite_master WHERE type = 'table' AND name = ?`
    );
  } catch (err) {
    console.warn(`[database] 读静态库表清单失败：${(err && err.message) || err}`);
    return true;
  }
  for (const table of STATIC_TABLES) {
    let exists = false;
    try {
      exists = Boolean(hasTable.get(table));
    } catch (_) {
      exists = false;
    }
    if (!exists) continue;
    try {
      db.exec(staticViewSql(table));
    } catch (err) {
      console.warn(`[database] 静态表视图 ${table} 建不起来：${(err && err.message) || err}`);
    }
  }
  // app_meta 统一视图：个人设置优先，静态键（数据日期 / 简中未实装名单…）从 game.db 补
  try {
    db.exec(META_VIEW_SQL);
  } catch (err) {
    console.warn(`[database] app_meta 合并视图建不起来：${(err && err.message) || err}`);
  }
  return true;
}

function open(dbPath, options = {}) {
  const target = dbPath || getDbPath();
  const gamePath = path.join(path.dirname(target), GAME_DB_NAME);
  // 迁移库结构时必须拿到「裸」个人库：挂上 game.db 会建同名临时视图，DROP TABLE 会撞名
  const attach = options.attachGame !== false;
  if (BetterSqlite3) {
    const db = new BetterSqlite3(target);
    try {
      db.pragma("journal_mode = WAL");
      if (attach) attachGame(db, gamePath);
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
      if (attach) attachGame(db, gamePath);
    } catch (err) {
      try { db.close(); } catch (_) { /* ignore */ }
      throw err;
    }
    return db;
  }
  throw new Error("未找到可用的 SQLite 驱动：请安装 better-sqlite3 或使用新版 Node/Electron");
}

function ensureSchema(db) {
  // 只建个人表（静态表只存在于随包的 game.db，迁移见 main/runtime-db.js）
  db.exec(PERSONAL_DDL);
  for (const sqlText of PERSONAL_ALTERS) {
    try {
      db.exec(sqlText);
    } catch (_) {
      // 列已存在
    }
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
// 个人数据导出 / 导入（跨端迁移，v0.3.8）
// ---------------------------------------------------------------------------
function exportPersonalData(db, appVersion) {
  return getDomain(db).backup.exportPersonalData({ appVersion });
}

function importPersonalData(db, text) {
  return getDomain(db).backup.importPersonalData(text);
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

// 冠位名单（终章柱子战）：只存 id 列表，合法性由界面保证
function getCrownServants(db, accountId) {
  return getDomain(db).crown.getCrownServants(accountId);
}

function saveCrownServants(db, servants, accountId) {
  return getDomain(db).crown.saveCrownServants(servants, accountId);
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

function renameUserTeam(db, id, name) {
  return getDomain(db).teams.renameUserTeam(id, name);
}

function getUserTeamResult(db, teamId) {
  return getDomain(db).teams.getUserTeamResult(teamId);
}

function saveUserTeamResult(db, payload) {
  return getDomain(db).teams.saveUserTeamResult(payload || {});
}

function deleteUserTeamResult(db, teamId) {
  return getDomain(db).teams.deleteUserTeamResult(teamId);
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
  getDomain,
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
  renameUserTeam,
  deleteUserTeam,
  getUserTeamResult,
  saveUserTeamResult,
  deleteUserTeamResult,
  getExclusions,
  saveExclusions,
  getCrownServants,
  saveCrownServants,
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
  exportPersonalData,
  importPersonalData,
};
