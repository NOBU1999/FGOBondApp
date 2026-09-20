#!/usr/bin/env node
"use strict";

/**
 * 组装安卓（Capacitor WebView）用的网页包：dist/android/public
 *
 * 产物结构（与仓库结构保持相对层级一致，宿主里的 ESM 相对路径才成立）：
 *   index.html / app.js / style.css / vendor/** / data/** / assets/**   ← 来自 renderer/
 *   shared/**                                                          ← 共用领域层与桥接
 *   platforms/android/web-host/**                                      ← 安卓宿主（sql.js 端口 / 启动脚本）
 *   vendor/sqljs/sql-wasm.js + sql-wasm.wasm                           ← sql.js 运行时
 *   db/fgo_data.db                                                     ← 静态数据（**已清空个人表**）
 *
 * 用法：node scripts/android/build-web-bundle.mjs
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "dist", "android", "public");
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const PERSONAL_TABLES = ["user_box", "user_exclusions", "user_teams", "custom_crafts", "accounts"];
const PERSONAL_META_KEYS = [
  "active_account_id",
  "server_region",
  "generic_bond_participation",
  "non_participating_craft_ids",
];

function log(...args) {
  console.log("[bundle]", ...args);
}

function copyFiles(srcDir, destDir, filter) {
  if (!existsSync(srcDir)) return 0;
  let count = 0;
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyFiles(src, dest, filter);
    } else if (!filter || filter(entry.name, src)) {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest);
      count += 1;
    }
  }
  return count;
}

/** 清掉个人数据，只留静态游戏数据（安全：绝不把用户数据打进 APK） */
function prepareDatabase(destFile) {
  const src = path.join(ROOT, "db", "fgo_data.db");
  if (!existsSync(src)) throw new Error("找不到 db/fgo_data.db");
  mkdirSync(path.dirname(destFile), { recursive: true });

  const { DatabaseSync } = require("node:sqlite");
  // 先把源库的 WAL 合并进主文件，否则只复制主文件会丢最新静态数据
  try {
    const srcDb = new DatabaseSync(src);
    try {
      srcDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (_) {
      /* 非 WAL 模式忽略 */
    }
    srcDb.close();
  } catch (err) {
    log("源库 checkpoint 失败（继续）：" + err.message);
  }

  cpSync(src, destFile);

  const db = new DatabaseSync(destFile);
  let removed = 0;
  for (const table of PERSONAL_TABLES) {
    try {
      const info = db.prepare(`DELETE FROM "${table}"`).run();
      removed += Number(info.changes || 0);
    } catch (_) {
      /* 表不存在 */
    }
  }
  for (const key of PERSONAL_META_KEYS) {
    try {
      db.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
    } catch (_) {
      /* ignore */
    }
  }
  try {
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('accounts','user_box','user_exclusions','user_teams','custom_crafts')").run();
  } catch (_) {
    /* ignore */
  }
  try {
    db.exec("VACUUM");
  } catch (_) {
    /* VACUUM 失败不影响正确性 */
  }

  const counts = {};
  for (const table of ["servants", "crafts", "servant_stage_traits", ...PERSONAL_TABLES]) {
    try {
      counts[table] = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
    } catch (_) {
      counts[table] = "-";
    }
  }
  db.close();
  log(`数据库已就绪：${path.relative(ROOT, destFile)}（清掉个人行 ${removed} 条）`);
  log("  表计数：" + JSON.stringify(counts));
}

// ---------------------------------------------------------------- 组装
log("清空输出目录：" + path.relative(ROOT, OUT));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const webCount = copyFiles(path.join(ROOT, "renderer"), OUT);
log(`renderer → 根目录：${webCount} 个文件`);

const sharedCount = copyFiles(
  path.join(ROOT, "shared"),
  path.join(OUT, "shared"),
  (name) => !name.endsWith(".md")
);
log(`shared/** → shared/**：${sharedCount} 个文件`);

const hostCount = copyFiles(
  path.join(ROOT, "platforms", "android", "web-host"),
  path.join(OUT, "platforms", "android", "web-host"),
  (name, src) => (name.endsWith(".js") || name.endsWith(".mjs")) && !src.includes("node-host")
);
log(`安卓宿主 → platforms/android/web-host：${hostCount} 个文件`);

const sqljsSrc = path.join(ROOT, "node_modules", "sql.js", "dist");
for (const file of ["sql-wasm.js", "sql-wasm.wasm"]) {
  const src = path.join(sqljsSrc, file);
  if (!existsSync(src)) throw new Error("缺少 sql.js 发行文件：" + src);
  cpSync(src, path.join(OUT, "vendor", "sqljs", file));
}
log("sql.js 运行时 → vendor/sqljs（sql-wasm.js + sql-wasm.wasm）");

prepareDatabase(path.join(OUT, "db", "fgo_data.db"));

// 事件加成表（桌面读 db 同目录的 JSON；有就一起带上）
const eventFile = path.join(ROOT, "db", "event_bond_bonus.json");
if (existsSync(eventFile)) {
  cpSync(eventFile, path.join(OUT, "db", "event_bond_bonus.json"));
  log("event_bond_bonus.json 一并打包");
}

// ---------------------------------------------------------------- 暂存 Python 源码（给 Chaquopy 用）
// 只挑真正需要的：engine 包的 .py 与 data/*.json（name_translations）+ 安卓入口。
// 千万别把整个 python-engine/ 交给 Chaquopy —— 那里有 .cache/raw（200MB 数据抓取缓存）、
// engine.exe / dist/ / build/（PyInstaller 产物），打进去会让 APK 暴涨到 116MB（实测）。
const PY_OUT = path.join(ROOT, "dist", "android", "python");
rmSync(PY_OUT, { recursive: true, force: true });
mkdirSync(PY_OUT, { recursive: true });

let pyCount = 0;
function stagePython(srcDir, destDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === "__pycache__") continue;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      stagePython(src, dest);
    } else if (entry.name.endsWith(".py") || entry.name.endsWith(".json")) {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest);
      pyCount += 1;
    }
  }
}
stagePython(path.join(ROOT, "python-engine", "engine"), path.join(PY_OUT, "engine"));
stagePython(path.join(ROOT, "platforms", "android", "python"), PY_OUT);
log(`Python 源码已暂存：${path.relative(ROOT, PY_OUT)}（${pyCount} 个文件，${(dirSize(PY_OUT) / 1048576).toFixed(2)} MB）`);

// ---------------------------------------------------------------- 注入启动脚本
// 界面里显示的版本 = 安卓的 versionName（"0.1.13+260920"）：由 build_all.mjs 传进来，
// 保证"系统设置里看到的版本"和"界面里看到的版本"是同一天、同一个号。
const APP_VERSION = process.env.FGO_ANDROID_VERSION || PKG.version;
const indexPath = path.join(OUT, "index.html");
let html = readFileSync(indexPath, "utf8");
const marker = '<script src="./app.js"></script>';
if (!html.includes(marker)) throw new Error("index.html 结构变了：找不到 app.js 引用，无法注入宿主");
if (!html.includes("web-host/boot.js")) {
  const inject = [
    `<script>window.__FGO_APP_VERSION = ${JSON.stringify(APP_VERSION)};</script>`,
    `<script src="./vendor/sqljs/sql-wasm.js"></script>`,
    `<script src="./platforms/android/web-host/boot.js"></script>`,
    marker,
  ].join("\n  ");
  html = html.replace(marker, inject);
  writeFileSync(indexPath, html, "utf8");
  log("index.html 已注入：版本号 + sql.js + 安卓宿主启动脚本");
} else {
  log("index.html 已包含宿主脚本（跳过注入）");
}

// ---------------------------------------------------------------- 统计
function dirSize(dir) {
  let total = 0;
  for (const entry of statSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}
const size = dirSize(OUT);
log(`完成：${path.relative(ROOT, OUT)}（${(size / 1048576).toFixed(1)} MB）`);
