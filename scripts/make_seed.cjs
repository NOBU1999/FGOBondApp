#!/usr/bin/env node
"use strict";

/**
 * 生成「干净的种子库」：db/fgo_data.seed.db
 *
 * 为什么需要它
 * ------------
 * 发布包里的 db/fgo_data.seed.db 是玩家首次运行时**复制成运行库**的模板，
 * 必须是「纯静态数据 + 空用户表」。
 *
 * 曾经的做法是打包时直接把开发机的工作库 db/fgo_data.db 复制成种子库
 * （package.json extraFiles: db/fgo_data.db → db/fgo_data.seed.db）。
 * 结果 v0.1.11 的 Windows 包里带上了开发者自己的账号 / Box / 队伍 / 排除名单
 * ——真实事故（玩家一装就看见开发者的数据）。
 *
 * 现在的做法
 * ----------
 * 复制一份副本再清空用户表，**绝不改动开发库本身**（开发库是你的测试数据）。
 *
 * 用法
 * ----
 *   node scripts/make_seed.cjs                          # db/fgo_data.db -> db/fgo_data.seed.db
 *   node scripts/make_seed.cjs --source <db> --out <db>
 *   node scripts/make_seed.cjs --check <db>             # 只体检某个库是否干净（0=干净）
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// 用户数据表：发布包里必须为空
const USER_TABLES = ["accounts", "user_box", "user_teams", "user_exclusions", "custom_crafts"];
// 用户偏好 / 本机状态：不随发布包分发
const USER_META_KEYS = ["server_region", "generic_bond_participation", "non_participating_craft_ids", "active_account_id"];

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
      out[t] = -1; // 表不存在（老库）
    }
  }
  return out;
}

function metaKeys(db) {
  try {
    return db
      .prepare("SELECT key FROM app_meta ORDER BY key")
      .all()
      .map((r) => r.key);
  } catch (_) {
    return [];
  }
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
    const keys = metaKeys(db);
    for (const k of USER_META_KEYS) {
      if (keys.includes(k)) problems.push(`app_meta 残留本机状态键 ${k}`);
    }
    return problems;
  } finally {
    db.close();
  }
}

/**
 * 在「副本」上做体检再丢掉。
 * 为什么要副本：只读打开 WAL 模式的库也会生成 -wal/-shm 旁路文件，
 * 直接在发布目录里打开会把发布包搞脏（实测踩过）。
 */
function withProbe(file, fn) {
  const dir = path.join(ROOT, ".temp", "seedprobe");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, path.basename(file));
  fs.copyFileSync(file, probe);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, probe + suffix);
  }
  try {
    return fn(probe);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ 体检模式
if (argv.includes("--check")) {
  const target = flagValue("--check", null);
  if (!target) {
    console.error("用法: node scripts/make_seed.cjs --check <种子库路径>");
    process.exit(2);
  }
  const file = path.resolve(target);
  const counts = withProbe(file, (probe) => {
    const db = new DatabaseSync(probe, { readOnly: true });
    try {
      return tableCounts(db, USER_TABLES);
    } finally {
      db.close();
    }
  });
  const problems = withProbe(file, (probe) => inspect(probe));
  console.log(`体检: ${file}`);
  console.log("  用户表行数: " + Object.entries(counts).map(([t, c]) => `${t}=${c}`).join(", "));
  if (problems.length) {
    problems.forEach((p) => console.error("  [FAIL] " + p));
    process.exit(1);
  }
  console.log("  [ok] 干净：无个人数据");
  process.exit(0);
}

// ------------------------------------------------------------------ 生成模式
const source = path.resolve(flagValue("--source", path.join(ROOT, "db", "fgo_data.db")));
const out = path.resolve(flagValue("--out", path.join(ROOT, "db", "fgo_data.seed.db")));

if (source === out) {
  console.error("✗ --source 与 --out 不能是同一个文件（本脚本只做副本，不动你的工作库）");
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`✗ 找不到数据源: ${source}`);
  console.error("  提示：db/fgo_data.db 是本地文件（不进仓库）。先跑一次应用里的「数据更新」，或从备份里找回。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });

// 1) 复制主库 + WAL/SHM 旁路（有 WAL 时直接复制主库可能丢最近写入）
fs.copyFileSync(source, out);
for (const suffix of ["-wal", "-shm"]) {
  const side = source + suffix;
  if (fs.existsSync(side)) fs.copyFileSync(side, out + suffix);
}

// 2) 在副本上清空用户数据
const db = new DatabaseSync(out);
let before = {};
let after = {};
try {
  db.exec("PRAGMA secure_delete = ON");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  before = tableCounts(db, USER_TABLES);
  for (const t of USER_TABLES) {
    if (before[t] >= 0) db.exec(`DELETE FROM "${t}"`);
  }
  const placeholders = USER_META_KEYS.map(() => "?").join(", ");
  db.prepare(`DELETE FROM app_meta WHERE key IN (${placeholders})`).run(...USER_META_KEYS);
  db.exec("VACUUM");
  after = tableCounts(db, USER_TABLES);
} finally {
  db.close();
}

// 3) 清掉旁路文件（副本已落盘）
for (const suffix of ["-wal", "-shm", "-journal"]) {
  const side = out + suffix;
  if (fs.existsSync(side)) {
    try {
      fs.unlinkSync(side);
    } catch (_) {
      /* 忽略 */
    }
  }
}

// 4) 自检：不干净就报错退出，绝不把脏种子库留在原地
const problems = withProbe(out, (probe) => inspect(probe));

// 体检是「只读打开」，但在 WAL 模式下也会生成 -wal/-shm 旁路文件 —— 落盘前再清一次
for (const suffix of ["-wal", "-shm", "-journal"]) {
  const side = out + suffix;
  if (fs.existsSync(side)) {
    try {
      fs.unlinkSync(side);
    } catch (_) {
      /* 忽略 */
    }
  }
}
console.log("=== 生成种子库 ===");
console.log("  源（开发库，未改动）: " + source);
console.log("  产物: " + out);
console.log("  清空前: " + Object.entries(before).map(([t, c]) => `${t}=${c}`).join(", "));
console.log("  清空后: " + Object.entries(after).map(([t, c]) => `${t}=${c}`).join(", "));
if (problems.length) {
  problems.forEach((p) => console.error("  [FAIL] " + p));
  console.error("✗ 种子库生成后仍不干净，请检查脚本逻辑");
  process.exit(1);
}
console.log("  [ok] 无个人数据，可安全打包");
