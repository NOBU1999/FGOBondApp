"use strict";

/**
 * 运行库准备：**只在启动时跑一次**（v0.3.8 起大幅简化）
 *
 * 现在的存储布局
 * --------------
 * - `db/game.db`      游戏静态数据，随包发布；装新版时整份替换（用户「更新数据」也会重写它）
 * - `db/fgo_data.db`  个人数据，不进发布包；升级永远不碰它
 *
 * 所以这里不再有「种子库版本比较 / 刷新 / 搬个人数据」那一整套逻辑 ——
 * 静态数据由发布包直接覆盖（用户 2026-11-27 拍板的口径：包内的永远优先），
 * 个人数据根本不在包里，也就无从被覆盖。
 *
 * 这里只剩两件事：
 * 1. 个人库不存在 → 建一个空库（新用户／用户自己删了想从零开始）
 * 2. 老版本（<=0.3.7）的单库 → 一次性拆开：静态表搬出去（没有随包库时用来生成 game.db），
 *    个人库里删掉静态表，备份留在 `db/backup/`
 */

const fs = require("fs");
const path = require("path");
const database = require("./database");
const {
  GAME_DB_NAME,
  LEGACY_SEED_NAME,
  PERSONAL_DB_NAME,
  STATIC_META_KEYS,
  STATIC_TABLES,
  USER_META_KEYS,
  USER_TABLES,
} = require("../shared/storage/schema.mjs");

const BACKUP_DIR = "backup";
const BACKUP_KEEP = 5;

function log(message) {
  console.log(`[runtime-db] ${message}`);
}

function quoteSql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function timestamp(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function removeSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch (_) {
      /* 删不掉不影响主流程 */
    }
  }
}

/** 用 SQLite 自己的备份通道复制（会自动把 WAL 合并进去） */
function copyDatabase(src, dst) {
  fs.rmSync(dst, { force: true });
  const db = database.open(src, { attachGame: false });
  try {
    db.exec(`VACUUM INTO ${quoteSql(dst)}`);
  } finally {
    db.close();
  }
}

function tableNames(db) {
  try {
    return new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => String(r.name))
    );
  } catch (_) {
    return new Set();
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
    /* 清理失败不影响主流程 */
  }
}

/** 新用户 / 个人库被删：建一个只有个人表的空库 */
function createPersonalDb(personalPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${personalPath}${suffix}`, { force: true });
  }
  fs.mkdirSync(path.dirname(personalPath), { recursive: true });
  const db = database.open(personalPath, { attachGame: false });
  try {
    database.ensureSchema(db);
  } finally {
    db.close();
  }
}

/**
 * 没有随包 `game.db` 时（开发环境），用老单库里的静态数据切一份出来。
 * 只复制静态表、只保留静态 meta 键。
 */
function extractGameDbFromLegacy(legacySnapshot, gamePath) {
  const tmp = `${gamePath}.tmp`;
  fs.rmSync(tmp, { force: true });
  copyDatabase(legacySnapshot, tmp);
  const db = database.open(tmp, { attachGame: false });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      for (const table of USER_TABLES) {
        try {
          db.exec(`DELETE FROM "${table}"`);
        } catch (_) {
          /* 老库里没有这张表 */
        }
      }
      const placeholders = USER_META_KEYS.map(() => "?").join(", ");
      try {
        db.prepare(`DELETE FROM app_meta WHERE key IN (${placeholders})`).run(...USER_META_KEYS);
      } catch (_) {
        /* 没有 app_meta 就算了 */
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    // 静态库用 DELETE 日志模式：主进程会长期 ATTACH 它，WAL 会白留两个旁路文件
    try {
      db.exec("PRAGMA journal_mode = DELETE");
    } catch (_) {
      /* ignore */
    }
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  fs.rmSync(gamePath, { force: true });
  fs.renameSync(tmp, gamePath);
  removeSidecars(gamePath);
}

/**
 * 一次性迁移：把老单库（静态 + 个人混在一起）拆开。
 * 先备份整份老库，再删个人库里的静态表与静态 meta 键（DDL/DML 都在一个事务里）。
 */
function migrateLegacyLayout({ personalPath, gamePath, backupDir }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const snapshot = path.join(backupDir, `fgo_data-${timestamp()}-before-split.db`);
  copyDatabase(personalPath, snapshot);
  log(`已备份老运行库：${path.basename(snapshot)}`);

  if (!fs.existsSync(gamePath)) {
    try {
      extractGameDbFromLegacy(snapshot, gamePath);
      log(`已从老运行库切出静态数据：${GAME_DB_NAME}（没有随包库时才会走到这一步）`);
    } catch (err) {
      log(`切出 ${GAME_DB_NAME} 失败（先不动个人库）：${err.message}`);
      return { action: "migrate-failed", error: err.message, backup: snapshot };
    }
  }

  const db = database.open(personalPath, { attachGame: false });
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      for (const table of STATIC_TABLES) {
        db.exec(`DROP TABLE IF EXISTS "${table}"`);
      }
      const placeholders = STATIC_META_KEYS.map(() => "?").join(", ");
      try {
        db.prepare(`DELETE FROM app_meta WHERE key IN (${placeholders})`).run(...STATIC_META_KEYS);
      } catch (_) {
        /* 没有 app_meta 就跳过 */
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    try {
      db.exec("VACUUM");
    } catch (_) {
      /* 磁盘紧张时 VACUUM 可能失败，不影响正确性 */
    }
  } catch (err) {
    log(`拆分个人库失败（数据仍在备份里）：${err.message}`);
    return { action: "migrate-failed", error: err.message, backup: snapshot };
  } finally {
    db.close();
  }

  pruneBackups(backupDir);
  log(`个人库已精简：静态表交给 ${GAME_DB_NAME}，Box / 账号 / 预设原样保留`);
  return { action: "migrated", backup: snapshot, personal: personalPath, game: gamePath };
}

/**
 * 确保两个库可用；返回 { action } 便于日志与测试。
 * action: created | keep | migrated | migrate-failed | no-game
 */
function ensureDatabases(dbDir) {
  const personalPath = path.join(dbDir, PERSONAL_DB_NAME);
  const gamePath = path.join(dbDir, GAME_DB_NAME);
  const backupDir = path.join(dbDir, BACKUP_DIR);
  const hasGame = fs.existsSync(gamePath);

  // ① 个人库不存在：新用户，直接建空库
  if (!fs.existsSync(personalPath)) {
    try {
      createPersonalDb(personalPath);
      log(`首次运行：已创建个人数据库 ${PERSONAL_DB_NAME}`);
      log(hasGame ? `静态数据：${GAME_DB_NAME}` : `⚠️ 缺少 ${GAME_DB_NAME}（发布包应带着它）`);
      return { action: "created", personal: personalPath, game: gamePath };
    } catch (err) {
      log(`创建个人数据库失败：${err.message}`);
      return { action: "failed", error: err.message };
    }
  }

  // ② 老单库：个人库里还有静态表 → 拆开
  let tables = new Set();
  try {
    const probe = database.open(personalPath, { attachGame: false });
    try {
      tables = tableNames(probe);
    } finally {
      probe.close();
    }
  } catch (err) {
    log(`个人数据库打不开：${err.message}（已隔离到 backup/，将重建空库）`);
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.renameSync(personalPath, path.join(backupDir, `fgo_data-corrupt-${timestamp()}.db`));
    } catch (_) {
      /* 挪不动就留在原地，下面重建会失败并如实报错 */
    }
    return ensureDatabases(dbDir);
  }

  const legacy = STATIC_TABLES.some((t) => tables.has(t));
  if (legacy) {
    return migrateLegacyLayout({ personalPath, gamePath, backupDir });
  }

  if (!hasGame) {
    log(`⚠️ 缺少 ${GAME_DB_NAME}：静态数据界面会是空的（请重新安装完整包，或在菜单里「更新数据」）`);
    return { action: "no-game", personal: personalPath, game: gamePath };
  }
  return { action: "keep", personal: personalPath, game: gamePath };
}

module.exports = {
  ensureDatabases,
  BACKUP_DIR,
  LEGACY_SEED_NAME,
  PERSONAL_DB_NAME,
  GAME_DB_NAME,
};
