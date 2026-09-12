"use strict";

/**
 * 运行库 / 种子库分离（v0.1.10）
 *
 * 背景
 * ----
 * 0.1.9 及以前：`db/fgo_data.db` 同时装着「静态数据」与「个人数据」，
 * 而这个文件又被直接打进发布包、落在运行时的同一个路径上。
 * 结果就是「解压覆盖到原文件夹」= 用一个空的用户表覆盖掉用户的 Box/账号。
 *
 * 现在的做法
 * --------
 * - 发布包只带 `db/fgo_data.seed.db`（纯静态数据，含空用户表）。
 * - 运行时始终使用 `db/fgo_data.db`，该文件永远不会出现在发布包里。
 * - 启动时：
 *     运行库不存在            -> 从种子复制一份（新用户 / 首次运行）
 *     种子比运行库新          -> 以种子为基底重建运行库，并把个人数据搬过去
 *     运行库比种子新          -> 不动（用户自己用「更新数据」更新过）
 *
 * 重建前会先 `VACUUM INTO` 备份旧库到 `db/backup/`，失败也不会破坏原库：
 * 整个替换过程只依赖两次同盘改名。
 */

const fs = require("fs");
const path = require("path");
const database = require("./database");

const RUNTIME_NAME = "fgo_data.db";
const SEED_NAME = "fgo_data.seed.db";
const NEW_NAME = "fgo_data.new.db";
const BACKUP_DIR = "backup";
const BACKUP_KEEP = 5;

// 需要从旧库搬到新库的个人数据表（顺序无关，都不带外键）
const USER_TABLES = [
  "accounts",
  "user_box",
  "user_exclusions",
  "user_teams",
  "custom_crafts",
];

// app_meta 里属于「用户偏好」的键：静态数据刷新时保留旧库的值
const USER_META_KEYS = [
  "active_account_id",
  "server_region",
  "generic_bond_participation",
  "non_participating_craft_ids",
];

function log(message) {
  console.log(`[runtime-db] ${message}`);
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function timestamp(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function safeName(value) {
  const clean = String(value || "").replace(/[^0-9A-Za-z_-]/g, "");
  return clean.slice(0, 24) || "unknown";
}

/** 同名文件已存在时追加序号，避免同一秒内的备份互相覆盖 */
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  const dir = path.dirname(base);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  for (let i = 2; i < 100; i += 1) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function withDb(dbPath, fn) {
  const db = database.open(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readMeta(dbPath, key) {
  try {
    return withDb(dbPath, (db) => database.getMetaValue(db, key) || "");
  } catch (_) {
    return "";
  }
}

function removeSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** 用 SQLite 自己的备份通道复制数据库（自动处理 WAL），目标文件必须不存在 */
function copyDatabase(src, dst) {
  fs.rmSync(dst, { force: true });
  withDb(src, (db) => {
    db.exec(`VACUUM INTO ${quoteSql(dst)}`);
  });
}

/**
 * 取表的列名。
 * 注意：`PRAGMA table_info(old.x)` 是非法语法（会静默返回空），
 * 必须用表值函数 `pragma_table_info(表, 库)`。
 */
function tableColumns(db, table, schema) {
  try {
    const rows = schema
      ? db.prepare("SELECT name FROM pragma_table_info(?, ?)").all(table, schema)
      : db.prepare("SELECT name FROM pragma_table_info(?)").all(table);
    return rows.map((r) => String(r.name));
  } catch (_) {
    return [];
  }
}

function tableExists(db, table, schema) {
  const prefix = schema ? `${schema}.` : "";
  const row = db
    .prepare(`SELECT name FROM ${prefix}sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return !!row;
}

/** 把旧库的个人数据搬到新库（列取交集，兼容旧版本缺列） */
function carryUserData(targetPath, sourcePath) {
  const db = database.open(targetPath);
  try {
    database.ensureSchema(db);
    db.exec(`ATTACH DATABASE ${quoteSql(sourcePath)} AS old`);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const table of USER_TABLES) {
        if (!tableExists(db, table, "old")) continue;
        const targetCols = tableColumns(db, table);
        const sourceCols = tableColumns(db, table, "old");
        const shared = targetCols.filter((c) => sourceCols.includes(c));
        if (!shared.length) continue;
        const cols = shared.map(quoteIdent).join(", ");
        db.exec("BEGIN");
        try {
          db.exec(`DELETE FROM main.${quoteIdent(table)}`);
          db.exec(
            `INSERT INTO main.${quoteIdent(table)} (${cols}) SELECT ${cols} FROM old.${quoteIdent(table)}`
          );
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
      // 保留旧库的用户偏好（静态数据相关 meta 以种子为准）
      for (const key of USER_META_KEYS) {
        const row = db.prepare("SELECT value FROM old.app_meta WHERE key = ?").get(key);
        if (row && row.value !== undefined && row.value !== null) {
          database.setMetaValue(db, key, row.value);
        }
      }
    } finally {
      db.exec("DETACH DATABASE old");
    }
    // 修正 AUTOINCREMENT 序列，避免搬运后新插入的 id 冲突
    try {
      for (const table of USER_TABLES) {
        const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${quoteIdent(table)}`).get();
        db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(
          table,
          Number((row && row.m) || 0)
        );
      }
    } catch (_) {
      // sqlite_sequence 不存在（没有 AUTOINCREMENT 表）时忽略
    }
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
}

function pruneBackups(backupDir) {
  try {
    const files = fs
      .readdirSync(backupDir)
      .filter((name) => /^fgo_data-.*\.db$/.test(name))
      .sort()
      .reverse();
    for (const name of files.slice(BACKUP_KEEP)) {
      fs.rmSync(path.join(backupDir, name), { force: true });
    }
  } catch (_) {
    // 清理失败不影响主流程
  }
}

/**
 * 确保运行库可用；返回 { action } 便于日志与测试。
 * action: no-seed | created | keep | refreshed | failed
 */
function ensureRuntimeDb(dbDir) {
  const runtime = path.join(dbDir, RUNTIME_NAME);
  const seed = path.join(dbDir, SEED_NAME);
  if (!fs.existsSync(seed)) return { action: "no-seed" };

  // 首次运行：直接从种子复制
  if (!fs.existsSync(runtime)) {
    try {
      copyDatabase(seed, runtime);
      log(`首次运行：已从 ${SEED_NAME} 创建运行库`);
      return { action: "created", runtime };
    } catch (err) {
      log(`创建运行库失败：${err.message}`);
      return { action: "failed", error: err.message };
    }
  }

  // 静态数据版本比较：seed 更新才刷新（用户自己更新过数据时不回退）
  const seedVersion = readMeta(seed, "updated_at");
  const runtimeVersion = readMeta(runtime, "updated_at");
  if (!seedVersion || (runtimeVersion && seedVersion <= runtimeVersion)) {
    return { action: "keep" };
  }

  return refreshRuntime({ dbDir, runtime, seed, seedVersion, runtimeVersion });
}

function refreshRuntime({ dbDir, runtime, seed, seedVersion, runtimeVersion }) {
  const newPath = path.join(dbDir, NEW_NAME);
  const backupDir = path.join(dbDir, BACKUP_DIR);
  let backupPath = "";
  let carryOk = true;

  // 1) 先备份旧库（失败也继续，但会记录）
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = uniquePath(
      path.join(backupDir, `fgo_data-${safeName(runtimeVersion)}-${timestamp()}.db`)
    );
    copyDatabase(runtime, backupPath);
    log(`已备份旧运行库：${path.basename(backupPath)}`);
  } catch (err) {
    backupPath = "";
    log(`备份旧运行库失败（继续刷新）：${err.message}`);
  }

  // 2) 以种子为基底建新库
  try {
    copyDatabase(seed, newPath);
  } catch (err) {
    log(`生成新运行库失败，已放弃刷新：${err.message}`);
    fs.rmSync(newPath, { force: true });
    return { action: "failed", error: err.message };
  }

  // 3) 把个人数据搬过去（失败则退回“纯种子库”，不让旧库/新库都不可用）
  try {
    carryUserData(newPath, runtime);
    log(`已搬移个人数据（账号 / Box / 排除 / 预设 / 自定义礼装）`);
  } catch (err) {
    carryOk = false;
    log(`搬移个人数据失败，改用未含个人数据的种子库：${err.message}`);
    try {
      copyDatabase(seed, newPath);
    } catch (err2) {
      fs.rmSync(newPath, { force: true });
      log(`重建失败，保留原运行库：${err2.message}`);
      return { action: "failed", error: err2.message };
    }
  }

  // 4) 同盘两次改名完成替换；失败则改名回滚
  const oldPath = `${runtime}.old`;
  try {
    fs.rmSync(oldPath, { force: true });
    removeSidecars(runtime);
    fs.renameSync(runtime, oldPath);
    try {
      fs.renameSync(newPath, runtime);
    } catch (err) {
      fs.renameSync(oldPath, runtime);
      throw err;
    }
    if (carryOk) {
      fs.rmSync(oldPath, { force: true });
    } else if (backupPath) {
      fs.rmSync(backupPath, { force: true });
      backupPath = "";
    } else {
      // 没有备份时把旧库留作隔离文件，方便人工抢救
      const quarantine = path.join(backupDir, `fgo_data-failed-${timestamp()}.db`);
      try {
        fs.renameSync(oldPath, quarantine);
        log(`旧运行库已隔离：${path.basename(quarantine)}`);
      } catch (_) {
        fs.rmSync(oldPath, { force: true });
      }
    }
  } catch (err) {
    fs.rmSync(newPath, { force: true });
    log(`替换运行库失败，原库未受影响：${err.message}`);
    return { action: "failed", error: err.message };
  }

  pruneBackups(backupDir);
  log(`静态数据已刷新：${runtimeVersion || "(空)"} -> ${seedVersion}`);
  return {
    action: "refreshed",
    runtime,
    backup: backupPath,
    carryOk,
    from: runtimeVersion,
    to: seedVersion,
  };
}

module.exports = {
  ensureRuntimeDb,
  RUNTIME_NAME,
  SEED_NAME,
  BACKUP_DIR,
  USER_TABLES,
  USER_META_KEYS,
};
