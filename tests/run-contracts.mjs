#!/usr/bin/env node
"use strict";

/**
 * 一致性契约测试运行器（全平台化 · 阶段 3 产物）
 *
 * 目的：把「界面 ↔ 宿主」和「宿主 ↔ 引擎」两份契约变成**任何平台都能跑**的用例。
 *       新平台（网页 / 安卓）实现完宿主后，跑同一套用例即可证明行为对齐。
 *
 * 用法：
 *   node tests/run-contracts.mjs                 # 跑全部（bridge + engine）
 *   node tests/run-contracts.mjs --suite bridge  # 只跑领域层契约
 *   node tests/run-contracts.mjs --suite engine  # 只跑引擎协议
 *   node tests/run-contracts.mjs --db <库路径>    # 换数据库（默认 db/fgo_data.db）
 *   node tests/run-contracts.mjs --host <模块>    # 换宿主实现（默认 Windows：main/database.js）
 *
 * 前置：
 *   - 需要 db/fgo_data.db（静态数据）。缺库时对应套件会 SKIP，不会误报通过。
 *   - engine 套件需要能跑 python（PYTHON 环境变量可覆盖解释器路径）。
 *
 * 退出码：0 = 全部通过（含 SKIP）；1 = 有失败。
 */

import { existsSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const args = process.argv.slice(2);

function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const SUITE = argValue("--suite", "all");
const DB_ARG = argValue("--db", path.join(ROOT, "db", "fgo_data.db"));
const HOST_MODULE = argValue("--host", null);
const TRANSPORT = argValue("--transport", "auto"); // auto | pipe | file
const VERBOSE = args.includes("--verbose");
const TMP_DIR = path.join(ROOT, "tests", ".tmp");

const results = { pass: 0, fail: 0, skip: 0 };
const failures = [];

function log(...a) {
  console.log(...a);
}

function pass(name, extra = "") {
  results.pass += 1;
  log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
}

function fail(name, reason) {
  results.fail += 1;
  failures.push({ name, reason });
  log(`  ❌ ${name}\n       → ${reason}`);
}

function skipSuite(name, reason) {
  results.skip += 1;
  log(`  ⏭  ${name} 跳过：${reason}`);
}

// ---------------------------------------------------------------------------
// 用例文件 & 通用工具
// ---------------------------------------------------------------------------
const loadCases = (file) => JSON.parse(readFileSync(path.join(ROOT, "tests", "contracts", file), "utf8"));

/** 取嵌套值：result.accounts[1].name / error / result */
function pick(obj, pathExpr) {
  const tokens = String(pathExpr)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[t];
  }
  return cur;
}

const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function describe(err) {
  if (!err) return "";
  return String(err.message || err);
}

// ---------------------------------------------------------------------------
// 准备一份干净的临时库（不含任何真实个人数据）
// ---------------------------------------------------------------------------
function prepareTempDb() {
  mkdirSync(TMP_DIR, { recursive: true });
  const target = path.join(TMP_DIR, "bridge.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const dst = target + suffix;
    if (existsSync(dst)) rmSync(dst, { force: true });
    if (existsSync(DB_ARG + suffix)) copyFileSync(DB_ARG + suffix, dst);
  }
  return target;
}

// ---------------------------------------------------------------------------
// 套件 1：领域层 / 桥接契约（默认宿主 = Windows：main/database.js）
// ---------------------------------------------------------------------------
async function runBridgeSuite() {
  log("");
  log("【bridge】界面 ↔ 宿主（领域层）契约");
  if (!existsSync(DB_ARG)) {
    skipSuite("bridge", `找不到数据库 ${path.relative(ROOT, DB_ARG)}`);
    return;
  }

  const database = require(path.join(ROOT, "main", "database.js"));
  const tmpDb = prepareTempDb();
  const db = database.open(tmpDb);
  database.ensureSchema(db);

  // 清空个人数据 + 自增序号，保证用例可重复、且绝不含真实用户数据
  for (const table of ["user_box", "user_exclusions", "user_teams", "custom_crafts", "accounts"]) {
    try {
      db.exec(`DELETE FROM "${table}"`);
    } catch (_) {
      /* 表还不存在 */
    }
  }
  try {
    db.exec(
      "DELETE FROM sqlite_sequence WHERE name IN ('accounts','user_box','user_exclusions','user_teams','custom_crafts')"
    );
  } catch (_) {
    /* ignore */
  }
  for (const key of ["active_account_id", "server_region", "generic_bond_participation", "non_participating_craft_ids"]) {
    try {
      db.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
    } catch (_) {
      /* ignore */
    }
  }
  database.ensureAccountSchema(db);

  // 给用例用的真实数据引用
  const firstServantId = database.get(db, "SELECT id FROM servants WHERE collection_no > 0 ORDER BY collection_no LIMIT 1").id;
  const servantWithTraits = database.get(
    db,
    "SELECT servant_id AS id FROM servant_stage_traits WHERE stage = 'fourth' AND trait <> 'unknown' ORDER BY servant_id LIMIT 1"
  ).id;
  const captureServantIds = database
    .all(db, "SELECT id FROM servants WHERE collection_no > 0 ORDER BY collection_no LIMIT 3")
    .map((r) => r.id);
  const capture = {
    cache: {
      replaced: {
        userSvt: captureServantIds.slice(0, 2).map((id) => ({ svtId: id })),
        userSvtStorage: captureServantIds.slice(2).map((id) => ({ svtId: id })),
        userSvtCollection: [
          { svtId: captureServantIds[0], friendshipRank: 10, friendshipExceedCount: 0 },
          { svtId: captureServantIds[1], friendshipRank: 11, friendshipExceedCount: 1 },
          { svtId: captureServantIds[2], friendshipRank: 15, friendshipExceedCount: 0 },
        ],
      },
    },
  };

  const resolveToken = (value) => {
    if (value === "$firstServantId") return firstServantId;
    if (value === "$servantWithTraits") return servantWithTraits;
    if (value === "$captureJson") return JSON.stringify(capture);
    if (Array.isArray(value)) return value.map(resolveToken);
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) out[k] = resolveToken(value[k]);
      return out;
    }
    return value;
  };

  // 宿主接口：新平台只需提供等价的 call(group, fn, args)
  let host;
  if (HOST_MODULE) {
    // 关键：自定义宿主（如 sql.js）读的是主库文件，而桌面驱动处于 WAL 模式，
    // 上面清空个人数据的改动可能还在 -wal 里 → 先 checkpoint 并释放句柄，宿主才能看到最新状态。
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (_) {
      /* 非 WAL 模式忽略 */
    }
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    // Windows 上必须用 file:// URL 加载绝对路径（Node 的 ESM 加载器限制）
    const mod = await import(pathToFileURL(path.resolve(ROOT, HOST_MODULE)).href);
    host = await mod.createHost({ dbPath: tmpDb });
  } else {
    host = {
      name: "windows (main/database.js)",
      async call(group, fn, callArgs) {
        const facade = database[fn];
        if (typeof facade !== "function") throw new Error(`宿主未实现 ${group}.${fn}`);
        return facade(db, ...callArgs);
      },
    };
  }
  log(`  宿主：${host.name}；库：${path.relative(ROOT, tmpDb)}`);

  const file = loadCases("bridge-cases.json");
  for (const c of file.cases) {
    const fn = c.method.split(".").pop();
    const callArgs = resolveToken(c.args || []);
    let actual;
    try {
      const value = await host.call(c.method.split(".")[0], fn, callArgs);
      actual = { ok: true, result: value === undefined ? null : value };
    } catch (err) {
      actual = { ok: false, error: describe(err) };
    }

    const problems = [];
    for (const exp of c.expect) {
      const got = pick(actual, exp.path);
      const want = resolveToken(exp.eq);
      if ("eq" in exp) {
        if (!same(got, want)) problems.push(`${exp.path} 应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
      } else if ("gte" in exp) {
        if (!(typeof got === "number" && got >= exp.gte)) problems.push(`${exp.path} 应 ≥ ${exp.gte}，实际 ${JSON.stringify(got)}`);
      } else if ("matches" in exp) {
        if (!(typeof got === "string" && new RegExp(exp.matches).test(got))) {
          problems.push(`${exp.path} 应匹配 /${exp.matches}/，实际 ${JSON.stringify(got)}`);
        }
      } else {
        problems.push(`用例写法错误：不认识的断言 ${JSON.stringify(exp)}`);
      }
    }
    if (problems.length) fail(c.name, problems.join("；"));
    else pass(c.name, VERBOSE ? JSON.stringify(actual).slice(0, 120) : "");
  }

  try {
    db.close();
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 套件 2：引擎协议契约
// ---------------------------------------------------------------------------
function runEngineOnce(request) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || "python";
    const child = spawn(python, [path.join("python-engine", "engine_launcher.py"), "--mode", "calculate", "--db", DB_ARG], {
      cwd: ROOT,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      reject(new Error("引擎超时（60s）"));
    }, 60000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      errText += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          resolve({ result: JSON.parse(lines[i]), stderr: errText, raw: lines[i] });
          return;
        } catch (_) {
          /* 继续往前找 */
        }
      }
      reject(new Error(errText.trim() || "引擎没有返回可解析的 JSON"));
    });
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

/**
 * 文件重定向传输：请求写进文件、结果重定向到文件（不使用父子进程管道）。
 * 用途：沙箱 / 部分 CI 禁止管道时，仍能验证引擎的 stdin→stdout 协议本身。
 * 注意：这是**测试传输方式**的替代，生产宿主（桌面）走的是管道。
 */
function runEngineOnceViaFile(request) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON || "python";
    const script = path.join(ROOT, "python-engine", "engine_launcher.py");
    mkdirSync(TMP_DIR, { recursive: true });
    const reqFile = path.join(TMP_DIR, "engine-req.json");
    const outFile = path.join(TMP_DIR, "engine-out.json");
    const errFile = path.join(TMP_DIR, "engine-err.log");
    writeFileSync(reqFile, JSON.stringify(request), "utf8");

    // 用真实文件当 stdin/stdout/stderr（既不是管道，也不需要 shell 重定向）
    const fdIn = openSync(reqFile, "r");
    const fdOut = openSync(outFile, "w");
    const fdErr = openSync(errFile, "w");
    const child = spawn(python, [script, "--mode", "calculate", "--db", DB_ARG], {
      cwd: ROOT,
      stdio: [fdIn, fdOut, fdErr],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    const cleanup = () => {
      for (const fd of [fdIn, fdOut, fdErr]) {
        try {
          closeSync(fd);
        } catch (_) {
          /* ignore */
        }
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      cleanup();
      reject(new Error("引擎超时（60s）"));
    }, 60000);
    child.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      cleanup();
      const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      const errText = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
      const lines = out.split(/\r?\n/).filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          resolve({ result: JSON.parse(lines[i]), stderr: errText, raw: lines[i] });
          return;
        } catch (_) {
          /* 继续往前找 */
        }
      }
      reject(new Error(errText.trim() || "引擎没有返回可解析的 JSON"));
    });
  });
}

/** 比较时剔除引擎内部诊断字段与可能含时间戳的验证串 */
function normalizeEngineResult(result) {  const out = {};
  for (const k of Object.keys(result || {})) {
    if (k.startsWith("_")) continue;
    if (k === "verificationToken" || k === "verificationTokenFull") continue;
    out[k] = result[k];
  }
  return out;
}

async function runEngineSuite() {
  log("");
  log("【engine】宿主 ↔ 计算引擎 协议契约");
  if (!existsSync(DB_ARG)) {
    skipSuite("engine", `找不到数据库 ${path.relative(ROOT, DB_ARG)}`);
    return;
  }

  const { DatabaseSync } = require("node:sqlite");
  const readDb = new DatabaseSync(DB_ARG, { readOnly: true });
  const servantIds = readDb
    .prepare("SELECT id FROM servants WHERE collection_no > 0 ORDER BY collection_no LIMIT 12")
    .all()
    .map((r) => Number(r.id));
  readDb.close();

  const file = loadCases("engine-cases.json");
  let previous = null;
  let transport = TRANSPORT === "auto" ? "pipe" : TRANSPORT;
  log(`  传输方式：${transport === "file" ? "文件重定向" : "管道（生产同款）"}；库：${path.relative(ROOT, DB_ARG)}`);

  for (const c of file.cases) {
    const req = { ...c.request };
    if (req.$boxRefs) {
      req.box = servantIds.slice(0, req.$boxRefs).map((id) => ({
        id,
        stage: "fourth",
        maxBond: false,
        bondSwitch1: false,
        bondSwitch2: false,
        personalBonus: 0,
        auraBonus: 0,
      }));
      delete req.$boxRefs;
    }

    let result;
    let thrown = null;
    const invoke = () => (transport === "file" ? runEngineOnceViaFile(req) : runEngineOnce(req));
    try {
      const run = await invoke();
      result = run.result;
    } catch (err) {
      thrown = err;
      // 受限环境（沙箱 / 某些 CI）会禁止父子进程管道：spawn EPERM
      // → 自动改用文件重定向再试一次（只影响测试传输方式，协议本身不变）
      if (transport !== "file" && /EPERM|ENOTSUP|EPIPE|EACCES/.test(describe(err))) {
        transport = "file";
        log(`  ⚠️ 当前环境禁止子进程管道（${describe(err)}）→ 改用文件重定向传输继续`);
        try {
          const run = await runEngineOnceViaFile(req);
          result = run.result;
          thrown = null;
        } catch (err2) {
          thrown = err2;
        }
      }
    }

    const isError = !result || result.status === "error";
    const errText = thrown ? describe(thrown) : result && result.message ? String(result.message) : "";
    const exp = c.expect;
    const problems = [];

    if (exp.errorContains !== undefined) {
      if (!isError) problems.push(`应报错（含「${exp.errorContains}」），实际成功返回`);
      else if (!errText.includes(exp.errorContains)) problems.push(`错误信息应含「${exp.errorContains}」，实际「${errText}」`);
    } else if (isError) {
      problems.push(`不应报错，实际错误：${errText}`);
    } else {
      if (exp.statusEq !== undefined && result.status !== exp.statusEq) {
        problems.push(`status 应为 ${exp.statusEq}，实际 ${JSON.stringify(result.status)}`);
      }
      const top = Array.isArray(result.top20) ? result.top20 : [];
      if (exp.top20LengthGte !== undefined && top.length < exp.top20LengthGte) {
        problems.push(`top20 至少 ${exp.top20LengthGte} 条，实际 ${top.length}`);
      }
      const first = top[0];
      if (exp.teamSizeEq !== undefined) {
        const size = first && Array.isArray(first.team) ? first.team.length : -1;
        if (size !== exp.teamSizeEq) problems.push(`首名队伍应 ${exp.teamSizeEq} 人，实际 ${size}`);
      }
      if (exp.positionsSetEq !== undefined) {
        const got = Array.from(new Set(((first && first.team) || []).map((m) => m.position))).sort();
        const want = [...exp.positionsSetEq].sort();
        if (!same(got, want)) problems.push(`位置集合应为 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
      }
      if (exp.top20CostUsedLte !== undefined) {
        const bad = top.find((t) => !(typeof t.costUsed === "number" && t.costUsed <= exp.top20CostUsedLte));
        if (bad) problems.push(`存在 costUsed 超过 ${exp.top20CostUsedLte} 的队伍：${JSON.stringify(bad.costUsed)}`);
      }
      if (exp.top20MultiplierGt !== undefined) {
        const bad = top.find((t) => !(typeof t.totalMultiplier === "number" && t.totalMultiplier > exp.top20MultiplierGt));
        if (bad) problems.push(`存在倍率不大于 ${exp.top20MultiplierGt} 的队伍`);
      }
      if (exp.tokenMatches !== undefined) {
        const token = String(result.verificationToken || "");
        if (!new RegExp(exp.tokenMatches).test(token)) {
          problems.push(`验证串应匹配 /${exp.tokenMatches}/，实际 ${JSON.stringify(token.slice(0, 24))}`);
        }
      }
      if (exp.sortModeEq !== undefined && result.sortMode !== exp.sortModeEq) {
        problems.push(`sortMode 应为 ${exp.sortModeEq}，实际 ${JSON.stringify(result.sortMode)}`);
      }
      if (exp.top20MonotonicBy !== undefined) {
        const key = exp.top20MonotonicBy === "points" ? "totalBondPoints" : "totalMultiplier";
        for (let i = 1; i < top.length; i += 1) {
          const prev = Number(top[i - 1][key] || 0);
          const cur = Number(top[i][key] || 0);
          if (cur > prev + 1e-9) {
            problems.push(`Top20 未按 ${exp.top20MonotonicBy} 单调不增（第 ${i + 1} 名大于第 ${i} 名）`);
            break;
          }
        }
      }
      if (exp.sameAsPrevious) {
        if (!previous) problems.push("没有上一条结果可供比较");
        else if (!same(normalizeEngineResult(result), normalizeEngineResult(previous))) {
          problems.push("与上一条结果不一致（协议要求：同样的请求 → 同样的结果）");
        }
      }
    }

    previous = result || null;
    if (problems.length) fail(c.name, problems.join("；"));
    else pass(c.name);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
log("一致性契约测试（contractVersion=1）");
if (SUITE === "all" || SUITE === "bridge") await runBridgeSuite();
if (SUITE === "all" || SUITE === "engine") await runEngineSuite();

log("");
log(`结果：通过 ${results.pass} / 失败 ${results.fail} / 跳过 ${results.skip}`);
if (failures.length) {
  log("失败明细：");
  for (const f of failures) log(`  - ${f.name}：${f.reason}`);
}
process.exit(results.fail ? 1 : 0);
