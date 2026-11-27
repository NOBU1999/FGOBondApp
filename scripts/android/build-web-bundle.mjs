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
 *   db/game.db                                                         ← 静态数据（个人数据不进包）
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

// 个人表 / 个人设置键的清单只认 shared/storage/schema.mjs 这一份：
// 各脚本各写一套时漏过一次（v0.3.1~v0.3.4 的 APK 曾带上 saved_results / user_crown_servants）。
const { USER_TABLES: PERSONAL_TABLES, USER_META_KEYS: PERSONAL_META_KEYS } = require("../../shared/storage/schema.mjs");

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

/**
 * 把随包静态库复制进网页包。
 *
 * v0.3.8 起不再「从开发库复制再清个人表」：静态库由 scripts/make_game_db.cjs 单独生成，
 * 这里只做两件事 —— **硬闸门体检**（任何个人表/个人设置键出现就中止出包）与复制。
 */
function prepareDatabase(destFile) {
  const src = path.join(ROOT, "db", "game.db");
  if (!existsSync(src)) {
    throw new Error("找不到 db/game.db —— 先跑 node scripts/make_game_db.cjs 生成静态库");
  }
  mkdirSync(path.dirname(destFile), { recursive: true });

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(src, { readOnly: true });
  const leaked = [];
  const counts = {};
  try {
    for (const table of PERSONAL_TABLES) {
      let n = -1;
      try {
        n = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
      } catch (_) {
        n = -1; // 表不存在（正确形态）
      }
      counts[table] = n;
      if (n > 0) leaked.push(`${table}=${n}`);
    }
    for (const key of PERSONAL_META_KEYS) {
      try {
        if (db.prepare("SELECT 1 FROM app_meta WHERE key = ?").get(key)) leaked.push(`app_meta:${key}`);
      } catch (_) {
        /* ignore */
      }
    }
    for (const table of ["servants", "crafts", "servant_stage_traits", "pillar_stage_traits"]) {
      try {
        counts[table] = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
      } catch (_) {
        counts[table] = "-";
      }
    }
  } finally {
    db.close();
  }
  if (leaked.length) {
    throw new Error("打包中止：静态库里混进了个人数据 → " + leaked.join(", "));
  }
  if (!counts.servants || counts.servants <= 0) {
    throw new Error("打包中止：db/game.db 里没有从者数据（重新跑 make_game_db.cjs）");
  }
  cpSync(src, destFile);
  log(`数据库已就绪：${path.relative(ROOT, destFile)}`);
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

// ---------------------------------------------------------------- TS 引擎（唯一的引擎）
// 引擎 bundle 是 classic worker 用 `importScripts` 加载的 IIFE（engine-ts/web.js），跟包放在 `engine-ts/` 下。
// 没有它安卓就没法算 —— 所以缺了直接 fail，不留"继续走别的引擎"这种歧义。
const TS_DIST = path.join(ROOT, "dist", "engine-ts");
const tsBundle = path.join(TS_DIST, "web.js");
if (!existsSync(tsBundle)) {
  throw new Error("缺少 dist/engine-ts/web.js —— 先跑 node scripts/build-engine-ts.mjs --web");
}
mkdirSync(path.join(OUT, "engine-ts"), { recursive: true });
cpSync(tsBundle, path.join(OUT, "engine-ts", "web.js"));
log(`TS 引擎 → engine-ts/web.js（${(statSync(tsBundle).size / 1024).toFixed(0)}KB）`);

prepareDatabase(path.join(OUT, "db", "game.db"));

// 事件加成表（桌面读 db 同目录的 JSON；有就一起带上）
const eventFile = path.join(ROOT, "db", "event_bond_bonus.json");
if (existsSync(eventFile)) {
  cpSync(eventFile, path.join(OUT, "db", "event_bond_bonus.json"));
  log("event_bond_bonus.json 一并打包");
}

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
