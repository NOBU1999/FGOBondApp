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
const DEFAULT_ACCOUNT_NAME = "默认账号";
const USER_BOX_COLUMNS = [
  "servant_id",
  "stage",
  "is_max_bond",
  "bond_switch1",
  "bond_switch2",
  "personal_bonus",
  "aura_bonus",
  "bond_rank",
  "bond_max_rank",
];

function tableColumns(db, table) {
  try {
    return db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((r) => String(r.name));
  } catch (_) {
    return [];
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * 建 accounts 表，并把旧版单账号数据迁移到账号 1。
 * 幂等：已有 account_id 列时只做常量级检查。
 */
function ensureAccountSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // 先把默认账号建好，供旧数据挂靠（account_id=1）
  db.prepare(
    "INSERT INTO accounts (id, name) SELECT 1, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = 1)"
  ).run(DEFAULT_ACCOUNT_NAME);

  migrateUserBoxAccounts(db);
  migrateUserExclusionsAccounts(db);

  // active_account_id 指向已删除账号时，回落到第一个账号
  const active = Number(getMetaValue(db, "active_account_id"));
  const hit = db.prepare("SELECT id FROM accounts WHERE id = ?").get(active || 0);
  if (!hit) {
    const first = db.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1").get();
    if (first) setMetaValue(db, "active_account_id", first.id);
  }
}

function migrateUserBoxAccounts(db) {
  const existing = tableColumns(db, "user_box");
  if (!existing.length || existing.includes("account_id")) return;
  const shared = USER_BOX_COLUMNS.filter((c) => existing.includes(c));
  if (!shared.includes("servant_id")) return;
  const cols = shared.map(quoteIdent).join(", ");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE user_box_account_mig (
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
    `);
    db.exec(
      `INSERT INTO user_box_account_mig (account_id, ${cols}) SELECT 1, ${cols} FROM user_box`
    );
    db.exec("DROP TABLE user_box");
    db.exec("ALTER TABLE user_box_account_mig RENAME TO user_box");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function migrateUserExclusionsAccounts(db) {
  const existing = tableColumns(db, "user_exclusions");
  if (!existing.length || existing.includes("account_id")) return;
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE user_exclusions_account_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL DEFAULT 1,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        UNIQUE(account_id, target_type, target_id)
      );
    `);
    db.exec(
      `INSERT INTO user_exclusions_account_mig (id, account_id, target_type, target_id)
       SELECT id, 1, target_type, target_id FROM user_exclusions`
    );
    db.exec("DROP TABLE user_exclusions");
    db.exec("ALTER TABLE user_exclusions_account_mig RENAME TO user_exclusions");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * 解析账号 id。
 * - 读取（forWrite=false）：显式传入优先；非法/已删除则回落到当前激活账号。
 * - 写入（forWrite=true）：显式传入但账号不存在时直接报错，
 *   避免前端拿着过期 id 把数据写进别的账号。
 */
function resolveAccountId(db, accountId, options = {}) {
  const wanted = Number(accountId);
  if (Number.isFinite(wanted) && wanted > 0) {
    const hit = db.prepare("SELECT id FROM accounts WHERE id = ?").get(wanted);
    if (hit) return Number(hit.id);
    if (options.forWrite) throw new Error("账号不存在或已被删除，请重新选择账号");
  }
  return getActiveAccountId(db);
}

function getActiveAccountId(db) {
  const active = Number(getMetaValue(db, "active_account_id"));
  const hit = db.prepare("SELECT id FROM accounts WHERE id = ?").get(active || 0);
  if (hit) return Number(hit.id);
  const first = db.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1").get();
  if (first) {
    setMetaValue(db, "active_account_id", first.id);
    return Number(first.id);
  }
  const info = run(db, "INSERT INTO accounts (name, note) VALUES (?, ?)", [
    DEFAULT_ACCOUNT_NAME,
    "",
  ]);
  setMetaValue(db, "active_account_id", info.lastInsertRowid);
  return Number(info.lastInsertRowid);
}

function getActiveAccount(db) {
  const id = getActiveAccountId(db);
  const row = get(db, "SELECT id, name FROM accounts WHERE id = ?", [id]);
  return row ? { id: Number(row.id), name: row.name } : { id, name: DEFAULT_ACCOUNT_NAME };
}

function listAccounts(db) {
  const accounts = all(
    db,
    `SELECT a.id, a.name, a.note, a.created_at AS createdAt,
            (SELECT COUNT(*) FROM user_box b WHERE b.account_id = a.id) AS servantCount,
            (SELECT COUNT(*) FROM user_exclusions e WHERE e.account_id = a.id) AS exclusionCount
     FROM accounts a
     ORDER BY a.id`
  ).map((r) => ({
    id: Number(r.id),
    name: r.name,
    note: r.note || "",
    createdAt: r.createdAt,
    servantCount: Number(r.servantCount || 0),
    exclusionCount: Number(r.exclusionCount || 0),
  }));
  const activeId = getActiveAccountId(db);
  return { accounts, activeId };
}

function normalizeAccountName(name, fallback) {
  const clean = String(name == null ? "" : name).trim().slice(0, 40);
  return clean || fallback;
}

function copyAccountData(db, fromId, toId) {
  const from = Number(fromId);
  const to = Number(toId);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
  const cols = USER_BOX_COLUMNS.map(quoteIdent).join(", ");
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT OR REPLACE INTO user_box (account_id, ${cols})
       SELECT ?, ${cols} FROM user_box WHERE account_id = ?`
    ).run(to, from);
    db.prepare(
      `INSERT OR IGNORE INTO user_exclusions (account_id, target_type, target_id)
       SELECT ?, target_type, target_id FROM user_exclusions WHERE account_id = ?`
    ).run(to, from);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function createAccount(db, name, options = {}) {
  const existing = all(db, "SELECT name FROM accounts").map((r) => r.name);
  let candidate = normalizeAccountName(name, "");
  if (!candidate) {
    let n = existing.length + 1;
    while (existing.includes(`账号 ${n}`)) n += 1;
    candidate = `账号 ${n}`;
  }
  const info = run(db, "INSERT INTO accounts (name, note) VALUES (?, ?)", [candidate, ""]);
  const id = Number(info.lastInsertRowid);
  const copyFrom = Number(options && options.copyFromId);
  if (Number.isFinite(copyFrom) && copyFrom > 0 && copyFrom !== id) {
    copyAccountData(db, copyFrom, id);
  }
  return { id, ...listAccounts(db) };
}

function renameAccount(db, id, name) {
  const target = Number(id);
  const clean = normalizeAccountName(name, "");
  if (!clean) throw new Error("账号名称不能为空");
  const info = run(db, "UPDATE accounts SET name = ? WHERE id = ?", [clean, target]);
  if (!info.changes) throw new Error("账号不存在");
  return listAccounts(db);
}

function duplicateAccount(db, id, name) {
  const source = Number(id);
  const hit = get(db, "SELECT id, name FROM accounts WHERE id = ?", [source]);
  if (!hit) throw new Error("账号不存在");
  const fallback = `${hit.name} 副本`;
  return createAccount(db, name || fallback, { copyFromId: source });
}

function deleteAccount(db, id) {
  const target = Number(id);
  const total = get(db, "SELECT COUNT(*) AS c FROM accounts");
  if (!total || Number(total.c) <= 1) throw new Error("至少保留一个账号");
  const hit = get(db, "SELECT id FROM accounts WHERE id = ?", [target]);
  if (!hit) throw new Error("账号不存在");
  db.exec("BEGIN");
  try {
    run(db, "DELETE FROM user_box WHERE account_id = ?", [target]);
    run(db, "DELETE FROM user_exclusions WHERE account_id = ?", [target]);
    run(db, "DELETE FROM accounts WHERE id = ?", [target]);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const active = getActiveAccountId(db);
  setMetaValue(db, "active_account_id", active);
  return listAccounts(db);
}

function setActiveAccount(db, id) {
  const target = Number(id);
  const hit = get(db, "SELECT id FROM accounts WHERE id = ?", [target]);
  if (!hit) throw new Error("账号不存在");
  setMetaValue(db, "active_account_id", target);
  return listAccounts(db);
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
function getUserBox(db, accountId) {
  const id = resolveAccountId(db, accountId);
  return all(
    db,
    "SELECT servant_id AS servantId, stage, is_max_bond AS isMaxBond, bond_switch1 AS bondSwitch1, bond_switch2 AS bondSwitch2, personal_bonus AS personalBonus, aura_bonus AS auraBonus, bond_rank AS bondRank, bond_max_rank AS bondMaxRank FROM user_box WHERE account_id = ?",
    [id]
  );
}

function saveUserBox(db, entries, accountId) {
  const id = resolveAccountId(db, accountId, { forWrite: true });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM user_box WHERE account_id = ?").run(id);
    const stmt = db.prepare(
      "INSERT INTO user_box (account_id, servant_id, stage, is_max_bond, bond_switch1, bond_switch2, personal_bonus, aura_bonus, bond_rank, bond_max_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const e of entries || []) {
      stmt.run(
        id,
        Number(e.servantId),
        e.stage || "fourth",
        e.isMaxBond ? 1 : 0,
        e.bondSwitch1 ? 1 : 0,
        e.bondSwitch2 ? 1 : 0,
        Number(e.personalBonus || 0),
        Number(e.auraBonus || 0),
        Number(e.bondRank || 0),
        Number(e.bondMaxRank || 0)
      );
    }
    db.exec("COMMIT");
    return { ok: true, count: (entries || []).length, accountId: id };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function resetUserBox(db, accountId) {
  return saveUserBox(db, [], accountId);
}

function importCaptureContent(db, content, accountId) {
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
      bondRank: bondRank,
      bondMaxRank: maxRank,
    });
  }
  saveUserBox(db, entries, accountId);
  return {
    servants: entries.length,
    maxBond: entries.filter((e) => e.isMaxBond).length,
  };
}

function getExclusions(db, accountId) {
  const id = resolveAccountId(db, accountId);
  const rows = all(
    db,
    "SELECT target_type AS targetType, target_id AS targetId FROM user_exclusions WHERE account_id = ?",
    [id]
  );
  return {
    servants: rows.filter((r) => r.targetType === "servant").map((r) => Number(r.targetId)),
    crafts: rows.filter((r) => r.targetType === "craft").map((r) => Number(r.targetId)),
    accountId: id,
  };
}

function saveExclusions(db, exclusions, accountId) {
  const id = resolveAccountId(db, accountId, { forWrite: true });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM user_exclusions WHERE account_id = ?").run(id);
    const stmt = db.prepare(
      "INSERT INTO user_exclusions(account_id, target_type, target_id) VALUES (?, ?, ?)"
    );
    for (const sid of exclusions.servants || []) stmt.run(id, "servant", Number(sid));
    for (const cid of exclusions.crafts || []) stmt.run(id, "craft", Number(cid));
    db.exec("COMMIT");
    return getExclusions(db, id);
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
