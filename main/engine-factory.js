"use strict";

/**
 * 引擎选择的唯一入口。
 *
 * **只用 TypeScript**（v0.3.0 起）：计算 / check / update 全部走 TS，
 * 发布包里**不再带** `python-engine/engine.exe`（体积与"两套实现"的债一起消掉）。
 *
 * 保留一个开关给开发/对拍：环境变量 `FGO_ENGINE=python`，且本地**确实有** engine.exe 时才生效；
 * 没有就一律 TS，绝不出现"切错了直接报缺文件"这种坑。
 *
 * 两个实现对外接口完全一致（calculate / check / update / stop / stderrTail / progress 事件）。
 */
const fs = require("fs");
const path = require("path");
const { getAppRoot } = require("./paths");

/** 文件开关：`engine-ts/engine.txt`（内容 ts 或 python），免得玩家去设环境变量 */
function engineFileKind() {
  try {
    const file = path.join(getAppRoot(), "engine-ts", "engine.txt");
    if (!fs.existsSync(file)) return null;
    const v = String(fs.readFileSync(file, "utf8")).trim().toLowerCase();
    if (!v) return null;
    return v === "ts" || v === "typescript" ? "ts" : "python";
  } catch (_) {
    return null;
  }
}

function engineKind() {
  const raw = String(process.env.FGO_ENGINE || "").trim().toLowerCase();
  if (raw) return raw === "ts" || raw === "typescript" ? "ts" : "python";
  return engineFileKind() ?? "ts";
}

/** TS 引擎的产物在不在（`npm run build:engine-ts` 生成；源码 clone 后没跑过就没有） */
function tsBundleReady() {
  try {
    return fs.existsSync(path.join(getAppRoot(), "dist", "engine-ts", "worker.mjs"));
  } catch (_) {
    return false;
  }
}

/** v0.3.0 起发布包只带 TS 引擎：Python 的 exe 不再随包，代码保留（回滚/对拍用） */
function pythonEngineReady() {
  try {
    return fs.existsSync(path.join(getAppRoot(), "python-engine", "engine.exe"));
  } catch (_) {
    return false;
  }
}

/**
 * @param {{dbPath?: string, mode?: "calculate"|"check"|"update"}} opts
 */
function createEngine({ dbPath, mode = "calculate" } = {}) {
  // 只要 TS 产物在，就用 TS：这条**不再看 engine.txt** —— 发布包里已经没有 Python 引擎，
  // 让人误切到 python 只会得到"缺文件"。开发/对拍要跑 Python 时显式设 FGO_ENGINE=python。
  const forcedPython = String(process.env.FGO_ENGINE || "").toLowerCase() === "python" && pythonEngineReady();
  const kind = forcedPython ? "python" : "ts";
  // v0.3.0：**计算 / check / update 全走 TS**。发布包里不再有 Python 引擎，
  // 保留 `FGO_ENGINE=python` 只给开发/对拍用（那时本地还有 engine.exe）。
  const useTs = kind === "ts" && tsBundleReady();
  if (kind === "ts" && !useTs) {
    console.warn(
      "[engine] 没找到 dist/engine-ts/worker.mjs，本次回退 Python 引擎（先跑 npm run build:engine-ts）",
    );
  }
  if (!useTs && !pythonEngineReady()) {
    throw new Error(
      "计算引擎缺失：既没找到 dist/engine-ts/worker.mjs，也没有 python-engine/engine.exe。请重新安装或运行 npm run build:engine-ts。",
    );
  }
  if (useTs) {
    const { EngineTsProcess } = require("./engine-ts-worker");
    return new EngineTsProcess({ dbPath });
  }
  const { PythonProcess } = require("./python-process");
  return new PythonProcess({ dbPath });
}

module.exports = { createEngine, engineKind };
