#!/usr/bin/env node
"use strict";

/**
 * 生成随包的**游戏静态数据库**：`db/game.db`（v0.3.8 起）
 *
 * 为什么
 * ------
 * 静态数据（从者 / 礼装 / 特性 / 灵衣 / 柱子战冻结表）与个人数据（账号 / Box / 预设…）
 * 拆成两个文件后，发布包里只带静态库，个人库根本不在包里 ⇒ 覆盖安装不可能丢个人数据，
 * 也不可能把开发机数据带出去（v0.1.11 那次事故的结构性预防）。
 *
 * 做法
 * ----
 * 从开发机库里**只复制静态表**，用户表与个人设置一概不复制。
 * 源库可以是老的单库（`db/fgo_data.db` 已带静态表），也可以是 `db/backup/` 里拆分前的快照。
 *
 * 用法
 * ----
 *   node scripts/make_game_db.cjs                      # 自动找源 → db/game.db
 *   node scripts/make_game_db.cjs --source <db> --out <db>
 *   node scripts/make_game_db.cjs --check <db>         # 体检：0 行个人数据才算干净
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const {
  PERSONAL_DB_NAME,
  STATIC_META_KEYS,
  STATIC_TABLES,
  USER_META_KEYS,
  USER_TABLES,
} = require("../shared/storage/schema.mjs");

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

function tableCounts(db, tables) {
  const out = {};
  for (const t of tables) {
    try {
      out[t] = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    } catch (_) {
      out[t] = -1;
    }
  }
  return out;
}

/** 静态数据指纹：各静态表行数 + updated_at（与引擎 staticDataRevision 同口径） */
function staticDataRevision(db) {
  const parts = [];
  for (const t of STATIC_TABLES) {
    let count = -1;
    try {
      count = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    } catch (_) {
      /* 表不存在 */
    }
    parts.push(`${t}=${count}`);
  }
  let updated = "";
  try {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'updated_at'").get();
    updated = row && row.value ? String(row.value) : "";
  } catch (_) {
    /* 忽略 */
  }
  parts.push(`updated_at=${updated}`);
  return parts.join("|");
}

/** 体检：返回问题列表（空数组 = 干净） */
function inspect(dbPath) {
  const problems = [];
  if (!fs.existsSync(dbPath)) return [`文件不存在: ${dbPath}`];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = tableCounts(db, USER_TABLES);
    for (const [t, c] of Object.entries(counts)) {
      if (c > 0) problems.push(`个人表 ${t} 有 ${c} 行（应为 0）`);
    }
    const staticCounts = tableCounts(db, STATIC_TABLES.slice(0, 7));
    for (const [t, c] of Object.entries(staticCounts)) {
      if (c <= 0) problems.push(`静态表 ${t} 是空的（应为正数）`);
    }
    let keys = [];
    try {
      keys = db.prepare("SELECT key FROM app_meta").all().map((r) => r.key);
    } catch (_) {
      problems.push("没有 app_meta 表");
    }
    for (const k of USER_META_KEYS) {
      if (keys.includes(k)) problems.push(`app_meta 残留个人设置键 ${k}`);
    }
    if (!keys.includes("updated_at")) problems.push("app_meta 缺少 updated_at（数据日期）");
    return problems;
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ 体检模式
if (argv.includes("--check")) {
  const target = flagValue("--check", null);
  if (!target) {
    console.error("用法: node scripts/make_game_db.cjs --check <库路径>");
    process.exit(2);
  }
  const file = path.resolve(target);
  const problems = inspect(file);
  const probe = new DatabaseSync(file, { readOnly: true });
  let revision = "";
  try {
    revision = staticDataRevision(probe);
  } finally {
    probe.close();
  }
  console.log(`体检: ${file}`);
  console.log(`  静态数据指纹: ${revision}`);
  if (problems.length) {
    problems.forEach((p) => console.error("  [FAIL] " + p));
    process.exit(1);
  }
  console.log("  [ok] 只有静态数据，无个人数据");
  process.exit(0);
}

// ------------------------------------------------------------------ 找源库
/** 源库必须带着静态表：优先 db/fgo_data.db，没有就找 db/backup 下最新的拆分前快照 */
function resolveSource() {
  const explicit = flagValue("--source", null);
  if (explicit) return path.resolve(explicit);
  const candidates = [path.join(ROOT, "db", PERSONAL_DB_NAME)];
  const backupDir = path.join(ROOT, "db", "backup");
  try {
    for (const name of fs
      .readdirSync(backupDir)
      .filter((n) => /^fgo_data-.*\.db$/.test(n))
      .sort()
      .reverse()) {
      candidates.push(path.join(backupDir, name));
    }
  } catch (_) {
    /* 没有备份目录 */
  }
  for (const file of candidates) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const n = db.prepare("SELECT COUNT(*) AS c FROM servants").get().c;
        if (Number(n) > 0) return file;
      } finally {
        db.close();
      }
    } catch (_) {
      /* 这张库里没有静态表，换下一个 */
    }
  }
  throw new Error(
    "找不到带静态数据的库（db/fgo_data.db 里没有 servants，db/backup 里也没有快照）。\n" +
      "  提示：先在有数据的环境里跑一次「更新数据」，或用 --source 指定一个老库。"
  );
}

const source = resolveSource();
const out = path.resolve(flagValue("--out", path.join(ROOT, "db", "game.db")));

if (source === out) {
  console.error("✗ --source 与 --out 不能是同一个文件");
  process.exit(2);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
for (const suffix of ["-wal", "-shm"]) fs.rmSync(out + suffix, { force: true });

// 1) 复制主库 + WAL/SHM 旁路
fs.copyFileSync(source, out);
for (const suffix of ["-wal", "-shm"]) {
  const side = source + suffix;
  if (fs.existsSync(side)) fs.copyFileSync(side, out + suffix);
}

// 2) 在副本上删掉个人数据
const db = new DatabaseSync(out);
let before = {};
let after = {};
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  before = tableCounts(db, USER_TABLES);
  db.exec("BEGIN");
  try {
    // 个人表在静态库里连表都不该存在（老单库复制过来的会带着空表，直接 DROP）
    for (const t of USER_TABLES) {
      try {
        db.exec(`DROP TABLE IF EXISTS "${t}"`);
      } catch (_) {
        /* 老库里没有这张表 */
      }
    }
    try {
      const placeholders = USER_TABLES.map(() => "?").join(", ");
      db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...USER_TABLES);
    } catch (_) {
      /* 没有 sqlite_sequence 的库 */
    }
    const placeholders = USER_META_KEYS.map(() => "?").join(", ");
    db.prepare(`DELETE FROM app_meta WHERE key IN (${placeholders})`).run(...USER_META_KEYS);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  // 静态指纹按落盘结果重算，避免与开发库不一致
  db.prepare("INSERT OR REPLACE INTO app_meta(key, value) VALUES('static_revision', ?)")
    .run(staticDataRevision(db));
  // 随包库用 DELETE 日志模式：主进程会长期 ATTACH 它，WAL 会白留两个旁路文件
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA secure_delete = ON");
  db.exec("VACUUM");
  after = tableCounts(db, USER_TABLES);
} finally {
  db.close();
}

for (const suffix of ["-wal", "-shm", "-journal"]) {
  fs.rmSync(out + suffix, { force: true });
}

const problems = inspect(out);
console.log("=== 生成随包静态库 ===");
console.log("  源（未改动）: " + source);
console.log("  产物: " + out);
console.log("  个人表（删除前）: " + Object.entries(before).map(([t, c]) => `${t}=${c}`).join(", "));
console.log("  个人表（删除后）: " + Object.entries(after).map(([t, c]) => `${t}=${c}`).join(", "));
if (problems.length) {
  problems.forEach((p) => console.error("  [FAIL] " + p));
  console.error("✗ game.db 不干净，请检查脚本逻辑");
  process.exit(1);
}
const stat = fs.statSync(out);
console.log(`  [ok] ${(stat.size / 1024 / 1024).toFixed(1)} MB，无个人数据，可安全打包`);
