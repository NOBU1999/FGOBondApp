"use strict";

/**
 * 引擎选择的唯一入口（strangler 期）：**默认仍然是 Python 引擎**，只有显式打开才走 TypeScript。
 *
 * 打开方式：
 *   · 环境变量 `FGO_ENGINE=ts`（开发/灰度自测）
 *   · 将来 P5 会把默认值改成 ts，并删掉 Python 引擎
 *
 * 两个实现对外接口完全一致（calculate / check / update / stop / stderrTail / progress 事件），
 * 所以调用方只需要把 `new PythonProcess({dbPath})` 换成 `createEngine({dbPath})`。
 */
const fs = require("fs");
const path = require("path");
const { getAppRoot } = require("./paths");

/** 文件开关：测试目录里放 `engine-ts/engine.txt`（内容 ts 或 python），免得玩家去设环境变量 */
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
  return engineFileKind() ?? "python";
}

/**
 * @param {{dbPath?: string, mode?: "calculate"|"check"|"update"}} opts
 *
 * 灰度收窄（2026-10-24）：`engineKind()==="ts"` 时**只有计算**走 TS；
 * `check` / `update` 仍用 Python（TS 的联网+写库还没在真机跑过）。
 * 要全量切：`FGO_ENGINE_ALL=1`。
 */
function createEngine({ dbPath, mode = "calculate" } = {}) {
  const kind = engineKind();
  const all = String(process.env.FGO_ENGINE_ALL || "") === "1";
  const useTs = kind === "ts" && (all || mode === "calculate");
  if (useTs) {
    const { EngineTsProcess } = require("./engine-ts-worker");
    return new EngineTsProcess({ dbPath });
  }
  const { PythonProcess } = require("./python-process");
  return new PythonProcess({ dbPath });
}

module.exports = { createEngine, engineKind };
