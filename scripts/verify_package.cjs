#!/usr/bin/env node
"use strict";

/**
 * 上传前自检：确认发布包（便携目录 / .7z / .zip / .apk）里
 *   1) 没有个人数据（种子库必须是空的用户表）
 *   2) 没有运行库 db/fgo_data.db、没有 db/backup 备份、没有日志
 *   3) 没有开发文件（交接文档、分析脚本、复现系统、测试脚本）
 *   4) 没有安卓/iOS 构建垃圾（node_modules、.class、.swift、.map —— v0.1.11 真实事故）
 *   5) 语言包已精简（只留 zh-CN / en-US）
 *
 * 用法：
 *   node scripts/verify_package.cjs                              # 检查 release/MyFGOApp
 *   node scripts/verify_package.cjs --app-dir <dir>
 *   node scripts/verify_package.cjs --archive <f.7z> [--archive <f.zip> ...]
 */

const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SEVEN_ZIP = "C:/Program Files/7-Zip/7z.exe";
const TEMP_DIR = path.join(ROOT, ".temp", "verify");

const USER_TABLES = ["accounts", "user_box", "user_teams", "user_exclusions", "custom_crafts"];
const USER_META_KEYS = ["server_region", "generic_bond_participation", "non_participating_craft_ids", "active_account_id"];
const ALLOWED_LOCALES = new Set(["zh-CN.pak", "en-US.pak"]);

const argv = process.argv.slice(2);
const argValues = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};

let failures = 0;
let warnings = 0;
const fail = (msg) => {
  failures++;
  console.error("  [FAIL] " + msg);
};
const warn = (msg) => {
  warnings++;
  console.error("  [warn] " + msg);
};
const ok = (msg) => console.log("  [ok] " + msg);

/** 发布包里绝不允许出现的路径特征 */
const PATH_RULES = [
  { re: /(^|\/)node_modules(\/|$)/i, msg: "安卓构建依赖 node_modules 混入发布包" },
  { re: /\.class$/i, msg: "Java/Kotlin 编译产物 (.class)" },
  { re: /\.swift$/i, msg: "iOS 源码 (.swift)" },
  { re: /\.map$/i, msg: "source map (.map)" },
  { re: /(^|\/)db\/fgo_data\.db$/i, msg: "运行库 fgo_data.db（个人数据）" },
  { re: /(^|\/)db\/backup(\/|$)/i, msg: "运行库备份目录 db/backup" },
  { re: /\.db-(wal|shm|journal)$/i, msg: "SQLite 旁路文件（-wal/-shm/-journal，不该随包发布）" },
  { re: /\.log$/i, msg: "日志文件 (.log)" },
  { re: /\.md$/i, msg: "文档文件 (.md)" },
  { re: /(^|\/)(CONTEXT_HANDOFF|PLATFORM-ROADMAP|ANDROID-BUILD|NEXT-SESSION-NOTICE)/i, msg: "本地交接文档" },
  { re: /(privacy_clean|reproduce_verification|dev-tests|smoke_out|verification_server|start_verification_server)/i, msg: "本地开发/复现脚本" },
];

function checkPaths(label, paths) {
  console.log(`--- ${label}：共 ${paths.length} 个条目 ---`);
  const hits = new Map();
  let localeFiles = [];
  let nonAscii = [];
  for (const p of paths) {
    const norm = p.replace(/\\/g, "/");
    for (const rule of PATH_RULES) {
      if (rule.re.test(norm)) {
        if (!hits.has(rule.msg)) hits.set(rule.msg, []);
        hits.get(rule.msg).push(norm);
      }
    }
    const base = norm.split("/").pop();
    // 目录模式下是 locales/xx.pak，压缩包模式下是 MyFGOApp/locales/xx.pak → 都算
    if (/(^|\/)locales\/[^/]+\.pak$/i.test(norm)) localeFiles.push(base);
    if (/[^\x20-\x7e]/.test(norm)) nonAscii.push(norm);
  }
  for (const [msg, list] of hits) {
    fail(`${msg}：${list.length} 个，例如 ${list.slice(0, 3).join(" / ")}`);
  }
  if (!hits.size) ok("无违禁文件（个人数据 / 开发文件 / 安卓-iOS 构建垃圾）");

  const extra = localeFiles.filter((n) => !ALLOWED_LOCALES.has(n));
  if (localeFiles.length === 0) {
    warn("没看到 locales 语言包（若用 electronLanguages 精简过则正常）");
  } else if (extra.length) {
    fail(`语言包未精简：除 zh-CN/en-US 外还有 ${extra.length} 个（例如 ${extra.slice(0, 3).join(", ")}）`);
  } else {
    ok(`语言包已精简：${localeFiles.sort().join(", ")}`);
  }

  if (nonAscii.length) {
    console.log("       含中文名的条目（正常，供人工核对）：");
    for (const n of nonAscii.slice(0, 10)) console.log("         " + n);
  }
  return { count: paths.length, nonAscii };
}

function walk(dir, acc = [], problems = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    problems.push(`无法读取目录（路径过长？）: ${dir} — ${e.code || e.message}`);
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc, problems);
    else acc.push(full);
  }
  return acc;
}

/**
 * 体检数据库内容。
 * 注意：只读打开 WAL 模式的库也会生成 -wal/-shm 旁路文件（实测把发布包搞脏过），
 * 所以这里始终对「副本」做体检，绝不碰原件。
 */
function inspectDb(dbPath) {
  const problems = [];
  if (!fs.existsSync(dbPath)) return [`未找到 ${dbPath}`];
  const probeDir = path.join(TEMP_DIR, "dbprobe");
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  const probe = path.join(probeDir, path.basename(dbPath));
  fs.copyFileSync(dbPath, probe);
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, probe + suffix);
  }
  const db = new DatabaseSync(probe, { readOnly: true });
  try {
    for (const t of USER_TABLES) {
      try {
        const c = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
        if (c > 0) problems.push(`个人表 ${t} 有 ${c} 行`);
      } catch (_) {
        /* 表不存在忽略 */
      }
    }
    try {
      const keys = db.prepare("SELECT key FROM app_meta").all().map((r) => r.key);
      for (const k of USER_META_KEYS) if (keys.includes(k)) problems.push(`app_meta 残留 ${k}`);
    } catch (_) {
      /* 忽略 */
    }
  } finally {
    db.close();
  }
  fs.rmSync(probeDir, { recursive: true, force: true });
  return problems;
}

function checkSeed(label, dbPath) {
  console.log(`--- ${label}：${path.relative(ROOT, dbPath)} ---`);
  const problems = inspectDb(dbPath);
  if (problems.length) {
    problems.forEach((p) => fail("种子库含个人数据：" + p));
  } else {
    ok("种子库干净（用户表全空、无本机状态键）");
  }
}

// ------------------------------------------------------------------ 便携目录
function verifyAppDir(appDir) {
  console.log(`\n=== 便携目录自检: ${path.relative(ROOT, appDir) || appDir} ===`);
  const problems = [];
  const files = walk(appDir, [], problems);
  problems.forEach((p) => fail(p));
  checkPaths("目录内容", files.map((f) => path.relative(appDir, f)));

  if (files.length > 400) fail(`文件数异常偏多（${files.length} 个，正常约 90 个）→ 疑似混入构建垃圾`);
  const totalBytes = files.reduce((s, f) => {
    try {
      return s + fs.statSync(f).size;
    } catch (_) {
      return s;
    }
  }, 0);
  console.log(`        体积 ${(totalBytes / 1048576).toFixed(1)} MB`);

  for (const must of ["python-engine/engine.exe", "resources/app.asar", "db/fgo_data.seed.db"]) {
    if (fs.existsSync(path.join(appDir, must))) ok(`存在 ${must}`);
    else fail(`缺少必需文件 ${must}`);
  }
  checkSeed("种子库", path.join(appDir, "db", "fgo_data.seed.db"));
  // 活动牵绊表随包发布：存在则必须是合法 JSON；缺失只警告（它由「更新数据」生成）
  {
    const bonusPath = path.join(appDir, "db", "event_bond_bonus.json");
    if (fs.existsSync(bonusPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(bonusPath, "utf8"));
        ok(`活动牵绊表 ${Array.isArray(parsed) ? parsed.length + " 条" : "（非数组结构）"}`);
      } catch (err) {
        fail("活动牵绊表不是合法 JSON：" + err.message);
      }
    } else {
      log("包内没有 db/event_bond_bonus.json（出包前先跑一次「更新数据」）");
    }
  }

  // app.asar 内部（代码主体）也扫一遍
  let asar = null;
  try {
    asar = require("@electron/asar");
  } catch (_) {
    warn("没装 @electron/asar，跳过 app.asar 内部扫描");
  }
  if (asar) {
    const asarPath = path.join(appDir, "resources", "app.asar");
    if (fs.existsSync(asarPath)) {
      const entries = asar.listPackage(asarPath).map((x) => x.replace(/\\/g, "/"));
      const hit = [];
      for (const e of entries) for (const rule of PATH_RULES) if (rule.re.test(e.replace(/^\//, ""))) hit.push(e + "  ← " + rule.msg);
      if (hit.length) fail(`app.asar 内含违禁文件 ${hit.length} 个，例如 ${hit.slice(0, 3).join(" / ")}`);
      else ok(`app.asar 内容干净（${entries.length} 个条目）`);
    }
  }
}

// ------------------------------------------------------------------ 压缩包
function listArchive(archive) {
  if (!fs.existsSync(SEVEN_ZIP)) throw new Error("找不到 7-Zip: " + SEVEN_ZIP);
  // 注意：不要用管道抓 7z 的输出（受限环境里 spawn 管道会 EPERM），改成写文件再读。
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const listFile = path.join(TEMP_DIR, "7z-list.txt");
  const fd = fs.openSync(listFile, "w");
  try {
    execFileSync(SEVEN_ZIP, ["l", "-slt", archive], { stdio: ["ignore", fd, "inherit"] });
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.readFileSync(listFile, "utf8");
  const paths = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("Path = ")) paths.push(line.slice(7));
  }
  // 第一行是压缩包自身
  return paths.filter((p) => path.resolve(p) !== path.resolve(archive));
}

function extract(archive, insidePath, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync(SEVEN_ZIP, ["e", archive, `-o${destDir}`, insidePath, "-y"], { stdio: "ignore" });
  } catch (_) {
    /* 下面按文件是否存在判断 */
  }
  return fs.existsSync(destDir) ? fs.readdirSync(destDir).filter((f) => fs.statSync(path.join(destDir, f)).isFile()) : [];
}

function verifyArchive(archive) {
  console.log(`\n=== 压缩包自检: ${path.basename(archive)} （${(fs.statSync(archive).size / 1048576).toFixed(1)} MB）===`);
  const paths = listArchive(archive);
  checkPaths("包内条目", paths);

  // 必须找到并检查种子库
  const norm = paths.map((p) => p.replace(/\\/g, "/"));
  const seedInside = paths.find((p, i) => /\/db\/fgo_data\.seed\.db$/.test(norm[i]) || /\/db\/fgo_data\.db$/.test(norm[i]));
  if (!seedInside) {
    fail("包内没有找到种子库（db/fgo_data.seed.db 或安卓 assets/public/db/fgo_data.db）");
    return;
  }
  const destName = path.basename(archive).replace(/[^\w.-]/g, "_");
  const dest = path.join(TEMP_DIR, destName);
  const got = extract(archive, seedInside, dest);
  if (!got.length) {
    fail(`无法从包内取出种子库: ${seedInside}`);
    return;
  }
  checkSeed("包内种子库", path.join(dest, got[0]));
}

// ------------------------------------------------------------------ main
const appDirs = argValues("--app-dir");
const archives = argValues("--archive");

if (!appDirs.length && !archives.length) {
  appDirs.push(path.join(ROOT, "release", "MyFGOApp"));
}
fs.mkdirSync(TEMP_DIR, { recursive: true });

for (const d of appDirs) verifyAppDir(path.resolve(d));
for (const a of archives) verifyArchive(path.resolve(a));

console.log(`\n=== 自检结论：${failures ? "✗ 不通过" : "✓ 通过"}（失败 ${failures} 项，警告 ${warnings} 项）===`);
process.exit(failures ? 1 : 0);
