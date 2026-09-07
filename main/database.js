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

function open(dbPath) {
  const target = dbPath || getDbPath();
  if (BetterSqlite3) {
    const db = new BetterSqlite3(target);
    db.pragma("journal_mode = WAL");
    return db;
  }
  if (NodeSqlite) {
    const db = new NodeSqlite.DatabaseSync(target);
    db.exec("PRAGMA journal_mode = WAL");
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
    CREATE TABLE IF NOT EXISTS user_exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      UNIQUE(target_type, target_id)
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
// 数据读取（Python 首次启动/更新后写入的库）
// ---------------------------------------------------------------------------
function listServants(db, region) {
  // 剔除 collection_no<=0 的非常规/未实装/重复从者（如未来实装角色），
  // 避免在 Box/排除/选择界面显示 0 号条目。
  const rows = all(db, "SELECT id, collection_no AS collectionNo, name, class, cost, rarity, atk_max AS atkMax, hp_max AS hpMax, type FROM servants WHERE collection_no > 0 ORDER BY collection_no");
  // 简中服模式只展示简中服已实装的灵衣
  const costumeTable = region === "cn" ? "servant_costume_traits_cn" : "servant_costume_traits";
  const costumeRows = all(db, `SELECT DISTINCT servant_id AS servantId, costume_id AS costumeId FROM ${costumeTable} ORDER BY servant_id, costume_id`);
  const costumeMap = {};
  for (const r of costumeRows) {
    if (!costumeMap[r.servantId]) costumeMap[r.servantId] = [];
    costumeMap[r.servantId].push(r.costumeId);
  }
  for (const r of rows) {
    r.costumes = costumeMap[r.id] || [];
  }
  return rows;
}

function getCostumeNames(db) {
  const rows = all(db, "SELECT costume_id AS costumeId, name FROM servant_costumes WHERE name <> ''");
  const result = {};
  for (const r of rows) result[String(r.costumeId)] = r.name;
  return result;
}

function getServant(db, servantId) {
  return get(db, "SELECT id, collection_no AS collectionNo, name, class, cost, rarity, atk_max AS atkMax, hp_max AS hpMax, type FROM servants WHERE id = ?", [servantId]);
}

function getStageTraits(db, servantId, stage, region) {
  const st = String(stage || "fourth");
  const useCn = region === "cn";
  if (st.startsWith("costume_")) {
    const costumeId = Number(st.split("_")[1]);
    if (!Number.isFinite(costumeId)) return [];
    const table = useCn ? "servant_costume_traits_cn" : "servant_costume_traits";
    const rows = all(
      db,
      `SELECT trait FROM ${table} WHERE servant_id = ? AND costume_id = ? AND trait <> 'unknown' ORDER BY trait`,
      [servantId, costumeId]
    );
    if (rows.length) return rows.map((r) => r.trait);
    // CN 库缺失时回退主库，避免旧数据/未更新数据直接空白
    if (useCn) {
      const fallback = all(
        db,
        "SELECT trait FROM servant_costume_traits WHERE servant_id = ? AND costume_id = ? AND trait <> 'unknown' ORDER BY trait",
        [servantId, costumeId]
      );
      return fallback.map((r) => r.trait);
    }
    return [];
  }
  const table = useCn ? "servant_stage_traits_cn" : "servant_stage_traits";
  const rows = all(
    db,
    `SELECT trait FROM ${table} WHERE servant_id = ? AND stage = ? AND trait <> 'unknown' ORDER BY trait`,
    [servantId, st]
  );
  if (rows.length) return rows.map((r) => r.trait);
  if (useCn) {
    const fallback = all(
      db,
      "SELECT trait FROM servant_stage_traits WHERE servant_id = ? AND stage = ? AND trait <> 'unknown' ORDER BY trait",
      [servantId, st]
    );
    return fallback.map((r) => r.trait);
  }
  return [];
}

function getAllStageTraits(db, servantId, region) {
  const useCn = region === "cn";
  const table = useCn ? "servant_stage_traits_cn" : "servant_stage_traits";
  const rows = all(
    db,
    `SELECT stage, trait FROM ${table} WHERE servant_id = ? AND trait <> 'unknown' ORDER BY stage, trait`,
    [servantId]
  );
  let result = {};
  for (const r of rows) {
    if (!result[r.stage]) result[r.stage] = [];
    result[r.stage].push(r.trait);
  }
  if (useCn && !Object.keys(result).length) {
    const fallbackRows = all(
      db,
      "SELECT stage, trait FROM servant_stage_traits WHERE servant_id = ? AND trait <> 'unknown' ORDER BY stage, trait",
      [servantId]
    );
    result = {};
    for (const r of fallbackRows) {
      if (!result[r.stage]) result[r.stage] = [];
      result[r.stage].push(r.trait);
    }
  }
  return result;
}

function listCrafts(db, bondOnly = false) {
  const sql = bondOnly
    ? "SELECT id, collection_no AS collectionNo, name, cost, rarity, bonus_type AS bonusType, bonus_value AS bonusValue, support_bonus AS supportBonus, trigger_traits_json AS triggerTraitsJson, detail, is_bond_ce AS isBondCe, is_event_limited AS isEventLimited FROM crafts WHERE is_bond_ce = 1 ORDER BY collection_no"
    : "SELECT id, collection_no AS collectionNo, name, cost, rarity, bonus_type AS bonusType, bonus_value AS bonusValue, support_bonus AS supportBonus, trigger_traits_json AS triggerTraitsJson, detail, is_bond_ce AS isBondCe, is_event_limited AS isEventLimited FROM crafts ORDER BY collection_no";
  const rows = all(db, sql);
  // 用户可见分类只保留两类：牵绊礼装 / 其他礼装
  for (const r of rows) {
    r.craftType = r.isBondCe ? "bond" : "other";
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 用户 Box / 队伍
// ---------------------------------------------------------------------------
function getUserBox(db) {
  return all(db, "SELECT servant_id AS servantId, stage, is_max_bond AS isMaxBond, bond_switch1 AS bondSwitch1, bond_switch2 AS bondSwitch2, personal_bonus AS personalBonus, aura_bonus AS auraBonus FROM user_box");
}

function saveUserBox(db, entries) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM user_box");
    const stmt = db.prepare(
      "INSERT INTO user_box (servant_id, stage, is_max_bond, bond_switch1, bond_switch2, personal_bonus, aura_bonus) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const e of entries || []) {
      stmt.run(
        Number(e.servantId),
        e.stage || "fourth",
        e.isMaxBond ? 1 : 0,
        e.bondSwitch1 ? 1 : 0,
        e.bondSwitch2 ? 1 : 0,
        Number(e.personalBonus || 0),
        Number(e.auraBonus || 0)
      );
    }
    db.exec("COMMIT");
    return { ok: true, count: (entries || []).length };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function resetUserBox(db) {
  return saveUserBox(db, []);
}

function importCaptureContent(db, content) {
  const raw = String(content || "").trim();
  let jsonText = raw;
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    // 抓包文件通常是 base64，末尾可能是 URL 编码的 %3D
    const normalized = raw.replace(/%3D/gi, "").trim();
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    jsonText = Buffer.from(padded, "base64").toString("utf8");
  }
  const data = JSON.parse(jsonText);
  const replaced = ((data || {}).cache || {}).replaced || {};
  const collection = replaced.userSvtCollection || [];
  const userSvt = replaced.userSvt || [];
  // Chaldea 会同时读取 userSvt 与 userSvtStorage（第二保管室），
  // iOS/Android 的抓包结构一致；只读 userSvt 会漏掉放在保管室中的从者。
  const userSvtStorage = replaced.userSvtStorage || [];
  // userSvtCollection 是图鉴/收集记录，只用来读取已持有从者的羁绊/满绊信息，
  // 绝不作为“是否持有”的依据；否则会把图鉴里有但已不在仓库的从者错误加入。
  const collectionMap = {};
  for (const rec of collection) {
    const sid = Number(rec && rec.svtId);
    if (Number.isFinite(sid)) collectionMap[sid] = rec;
  }
  const servantIds = new Set(all(db, "SELECT id FROM servants").map((r) => r.id));
  const ownedIds = new Set();
  for (const rec of [...userSvt, ...userSvtStorage]) {
    const sid = Number(rec && rec.svtId);
    if (Number.isFinite(sid) && servantIds.has(sid)) ownedIds.add(sid);
  }
  const entries = [];
  for (const sid of ownedIds) {
    const colRec = collectionMap[sid];
    const bondRank = Number(colRec && colRec.friendshipRank || 0);
    // Chaldea 规则：
    // - 普通从者默认牵绊上限 10；每使用一个“牵绊上限开放”道具，上限 +1
    // - 玛修基础上限特殊（Chaldea 中为 5），同样按 exceedCount 递增
    // 满绊 = 当前 rank 已达到当前最大可达到 rank（10/10、11/11、13/13、15/15…）
    // 而不是简单 >=15；10/10、11/11 这类旧上限满绊不应获得 25% 全队加成。
    const exceedCount = Number(colRec && colRec.friendshipExceedCount || 0);
    const isMash = Number(sid) === 800100;
    const defaultMaxRank = isMash ? 5 : 10;
    const maxRank = defaultMaxRank + exceedCount;
    const isAtBondLimit = bondRank > 0 && bondRank >= maxRank;
    const hasTeam25Bonus = bondRank >= 15;
    entries.push({
      servantId: sid,
      stage: "fourth",
      isMaxBond: isAtBondLimit ? 1 : 0,
      bondSwitch1: hasTeam25Bonus ? 1 : 0,
      bondSwitch2: 0,
      personalBonus: 0,
    });
  }
  saveUserBox(db, entries);
  return {
    servants: entries.length,
    maxBond: entries.filter((e) => e.isMaxBond).length,
  };
}

function getExclusions(db) {
  const rows = all(db, "SELECT target_type AS targetType, target_id AS targetId FROM user_exclusions");
  return {
    servants: rows.filter((r) => r.targetType === "servant").map((r) => Number(r.targetId)),
    crafts: rows.filter((r) => r.targetType === "craft").map((r) => Number(r.targetId)),
  };
}

function saveExclusions(db, exclusions) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM user_exclusions");
    const stmt = db.prepare("INSERT INTO user_exclusions(target_type, target_id) VALUES (?, ?)");
    for (const id of exclusions.servants || []) stmt.run("servant", Number(id));
    for (const id of exclusions.crafts || []) stmt.run("craft", Number(id));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function getMetaValue(db, key) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMetaValue(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)").run(key, String(value));
}

function getCnUnavailableBondCeIds(db) {
  try {
    const raw = getMetaValue(db, "cn_unavailable_bond_ce_ids");
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch (_) {
    return [];
  }
}

function getServerRegion(db) {
  const raw = getMetaValue(db, "server_region");
  return raw === "cn" ? "cn" : "jp";
}

function setServerRegion(db, region) {
  setMetaValue(db, "server_region", region === "cn" ? "cn" : "jp");
}

function getGenericBondParticipation(db) {
  try {
    const raw = getMetaValue(db, "generic_bond_participation");
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch (_) {
    return [];
  }
}

function setGenericBondParticipation(db, ids) {
  const list = Array.from(new Set((ids || []).map(Number))).filter((n) => Number.isFinite(n));
  setMetaValue(db, "generic_bond_participation", JSON.stringify(list));
  return getGenericBondParticipation(db);
}

function getNonParticipatingCraftIds(db) {
  try {
    const raw = getMetaValue(db, "non_participating_craft_ids");
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch (_) {
    return [];
  }
}

function setNonParticipatingCraftIds(db, ids) {
  const list = Array.from(new Set((ids || []).map(Number))).filter((n) => Number.isFinite(n));
  setMetaValue(db, "non_participating_craft_ids", JSON.stringify(list));
  return getNonParticipatingCraftIds(db);
}

function listCustomCrafts(db) {
  const rows = all(
    db,
    "SELECT id, name, craft_type AS craftType, cost, rarity, percent_bonus AS percentBonus, flat_bonus AS flatBonus, condition_groups_json AS conditionGroupsJson, repeatable, enabled FROM custom_crafts ORDER BY id"
  );
  for (const r of rows) {
    try {
      r.conditionGroups = JSON.parse(r.conditionGroupsJson || "[]");
    } catch (_) {
      r.conditionGroups = [];
    }
    delete r.conditionGroupsJson;
    r.percentBonus = Number(r.percentBonus || 0);
    r.flatBonus = Number(r.flatBonus || 0);
    r.repeatable = !!r.repeatable;
    r.enabled = !!r.enabled;
  }
  return rows;
}

function saveCustomCrafts(db, items) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM custom_crafts");
    const stmt = db.prepare(
      `INSERT INTO custom_crafts
        (id, name, craft_type, cost, rarity, percent_bonus, flat_bonus,
         condition_groups_json, repeatable, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of items || []) {
      const id = Number(item.id);
      if (Number.isFinite(id) && id > 0) {
        stmt.run(
          id,
          String(item.name || "").trim(),
          item.craftType === "other" ? "other" : "bond",
          Math.max(0, Math.round(Number(item.cost || 0))),
          Math.max(0, Math.round(Number(item.rarity || 0))),
          Number(item.percentBonus || 0),
          Number(item.flatBonus || 0),
          JSON.stringify(Array.isArray(item.conditionGroups) ? item.conditionGroups : []),
          item.repeatable ? 1 : 0,
          item.enabled === false ? 0 : 1
        );
      } else {
        stmt.run(
          null,
          String(item.name || "").trim(),
          item.craftType === "other" ? "other" : "bond",
          Math.max(0, Math.round(Number(item.cost || 0))),
          Math.max(0, Math.round(Number(item.rarity || 0))),
          Number(item.percentBonus || 0),
          Number(item.flatBonus || 0),
          JSON.stringify(Array.isArray(item.conditionGroups) ? item.conditionGroups : []),
          item.repeatable ? 1 : 0,
          item.enabled === false ? 0 : 1
        );
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return listCustomCrafts(db);
}

function saveUserTeam(db, team) {
  const supportCraftId = team.supportCraftId !== undefined && team.supportCraftId !== null ? team.supportCraftId : null;
  const supportSecondCraftId = team.supportSecondCraftId !== undefined && team.supportSecondCraftId !== null ? team.supportSecondCraftId : null;
  const info = run(
    db,
    `INSERT INTO user_teams (name, fixed_servants, fixed_crafts, support_id, support_craft_id, support_second_craft_id, support_position, cost_limit, strategy, quality_mode, mode, crown_class, crown_positions, base_bond)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      team.name || "",
      JSON.stringify(team.fixedServants || []),
      JSON.stringify(team.fixedCrafts || []),
      team.supportId || null,
      supportCraftId,
      supportSecondCraftId,
      team.supportPosition || "front_right",
      team.costLimit || 116,
      team.strategy || "total_max",
      team.qualityMode || "balanced",
      team.mode || "normal",
      team.crownClass || "all",
      JSON.stringify(team.crownPositions || []),
      Number(team.baseBond || 0),
    ]
  );
  return info.lastInsertRowid;
}

function listUserTeams(db) {
  const rows = all(
    db,
    "SELECT id, name, fixed_servants AS fixedServants, fixed_crafts AS fixedCrafts, support_id AS supportId, support_craft_id AS supportCraftId, support_second_craft_id AS supportSecondCraftId, support_position AS supportPosition, cost_limit AS costLimit, strategy, quality_mode AS qualityMode, mode, crown_class AS crownClass, crown_positions AS crownPositions, base_bond AS baseBond, created_at AS createdAt FROM user_teams ORDER BY id DESC"
  );
  for (const r of rows) {
    try {
      r.fixedServants = JSON.parse(r.fixedServants || "[]");
    } catch (_) {
      r.fixedServants = [];
    }
    try {
      r.fixedCrafts = JSON.parse(r.fixedCrafts || "[]");
    } catch (_) {
      r.fixedCrafts = [];
    }
    try {
      r.crownPositions = JSON.parse(r.crownPositions || "[]");
    } catch (_) {
      r.crownPositions = [];
    }
  }
  return rows;
}

function deleteUserTeam(db, id) {
  const info = run(db, "DELETE FROM user_teams WHERE id = ?", [Number(id)]);
  return { ok: info.changes > 0, changes: info.changes };
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
