"use strict";

/**
 * 引擎选择的唯一入口。
 *
 * **默认 TypeScript**（2026-10-24 起）。两个让它"退回去"的开关：
 *   · 环境变量 `FGO_ENGINE=python`（开发/对拍时用）
 *   · `<appRoot>/engine-ts/engine.txt` 内容 `python`（测试目录里给玩家手测用）
 *
 * 两个实现对外接口完全一致（calculate / check / update / stop / stderrTail / progress 事件）。
 *
 * ⚠️ 灰度收窄仍在：`check` / `update` 继续走 Python（TS 的联网+写库还没在真机跑过），
 *    要全切设 `FGO_ENGINE_ALL=1`。**v0.3.0 删掉 Python 侧时，这两条要一起改成 TS**
 *    （清单见 `文档\活跃\方案-引擎TS重写.md` §28.3）。
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

/**
 * @param {{dbPath?: string, mode?: "calculate"|"check"|"update"}} opts
 */
function createEngine({ dbPath, mode = "calculate" } = {}) {
  const kind = engineKind();
  const all = String(process.env.FGO_ENGINE_ALL || "") === "1";
  const wanted = kind === "ts" && (all || mode === "calculate");
  // 产物缺失时退回 Python：宁可慢一点，也别让"直接 npm start"的用户一算就报错
  const useTs = wanted && tsBundleReady();
  if (wanted && !useTs) {
    console.warn(
      "[engine] 没找到 dist/engine-ts/worker.mjs，本次回退 Python 引擎（先跑 npm run build:engine-ts）",
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
