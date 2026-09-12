"use strict";

/**
 * 重置数据库 = 重建静态数据（从者 / 礼装 / 特性 / 灵衣）
 *
 * 与「更新数据」的区别：
 * - 更新数据：按 ETag 增量更新，上游删掉的条目会残留在本地
 * - 重置数据库：先清空静态表，再强制重建一次，等于把静态数据"洗干净"
 *
 * 个人数据（账号 / Box / 排除 / 固定预设 / 自定义礼装）**一律不动**。
 * 重建失败或重建后读不到数据时，会用备份文件自动回滚。
 */

const fs = require("fs");
const path = require("path");
const database = require("./database");
const { getDbPath } = require("./paths");
const { PythonProcess } = require("./python-process");

// 静态数据表（按外键依赖顺序清空）
const STATIC_TABLES = [
  "servant_costume_traits_cn",
  "servant_costume_traits",
  "servant_stage_traits_cn",
  "servant_stage_traits",
  "servant_costumes",
  "servants",
  "crafts",
];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 把 WAL 落盘，保证直接复制文件是完整的 */
function checkpoint(dbPath) {
  const db = database.open(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function countStatic(dbPath) {
  const db = database.open(dbPath);
  try {
    const one = (sql) => {
      try {
        return Number(db.prepare(sql).get().c || 0);
      } catch (_) {
        return 0;
      }
    };
    return {
      servants: one("SELECT COUNT(*) AS c FROM servants"),
      crafts: one("SELECT COUNT(*) AS c FROM crafts"),
      stageTraits: one("SELECT COUNT(*) AS c FROM servant_stage_traits"),
      costumes: one("SELECT COUNT(*) AS c FROM servant_costumes"),
    };
  } finally {
    db.close();
  }
}

function clearStaticTables(dbPath) {
  const db = database.open(dbPath);
  try {
    database.ensureSchema(db);
    const cleared = {};
    for (const table of STATIC_TABLES) {
      try {
        cleared[table] = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c || 0);
      } catch (_) {
        cleared[table] = -1; // 表不存在
      }
    }
    db.exec("BEGIN");
    try {
      for (const table of STATIC_TABLES) {
        if (cleared[table] >= 0) db.exec(`DELETE FROM "${table}"`);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return cleared;
  } finally {
    db.close();
  }
}

function restoreFrom(backupPath, dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch (_) {
      // ignore
    }
  }
  fs.copyFileSync(backupPath, dbPath);
}

/**
 * 执行重置。返回 { ok, backup, before, cleared, after, engine }
 * onProgress(message) 用来把引擎进度转发到界面。
 */
async function resetStaticData({ onProgress } = {}) {
  const dbPath = getDbPath();
  const backupDir = path.join(path.dirname(dbPath), "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-reset-${stamp()}.db`);

  // 1) 备份（先 checkpoint，保证拷贝到完整数据）
  checkpoint(dbPath);
  fs.copyFileSync(dbPath, backupPath);

  // 2) 清空静态表
  const before = countStatic(dbPath);
  const cleared = clearStaticTables(dbPath);

  // 3) 强制重建（优先用本地缓存，缓存缺失时才联网）
  const engine = new PythonProcess({ dbPath });
  if (onProgress) engine.on("progress", (text) => onProgress(text));
  let engineResult = null;
  try {
    engineResult = await engine.update(true);
  } catch (err) {
    restoreFrom(backupPath, dbPath);
    throw new Error(
      `重建失败，已自动回滚到重置前的数据。原因：${(err && err.message) || err}`
    );
  }

  // 4) 校验结果；异常则回滚
  const after = countStatic(dbPath);
  if (!after.servants) {
    restoreFrom(backupPath, dbPath);
    throw new Error(
      "重建后没有读到从者数据，已自动回滚。请检查网络后重试，" +
        "或在「更新数据」里使用「强制更新」。"
    );
  }

  return {
    ok: true,
    backup: path.basename(backupPath),
    before,
    cleared,
    after,
    engine: engineResult,
  };
}

module.exports = { resetStaticData, STATIC_TABLES };
