"use strict";

/**
 * 引擎入口。**只有 TypeScript 一种实现**（v0.3.0 起默认，v0.3.1 起 Python 侧已从仓库移除）。
 *
 * 计算 / check / update 全部跑同一个引擎产物，只是**外壳**两种（算法/接口完全一致）：
 *   - worker_threads：`dist/engine-ts/worker.mjs`（默认，与主进程同堆）
 *   - 独立子进程：`dist/engine-ts/child.mjs`（设置→高级打开，需重启生效）
 * 产物缺失时**直接报错**，不回退到别的实现 —— 免得用户看到"缺文件"这种二手错误。
 *
 * 对外接口（两套外壳一致）：calculate / check / update / stop / stderrTail / progress 事件。
 */
const fs = require("fs");
const path = require("path");
const { getAppRoot } = require("./paths");
const engineConfig = require("./engine-config");

function bundleReady(name) {
  try {
    return fs.existsSync(path.join(getAppRoot(), "dist", "engine-ts", name));
  } catch (_) {
    return false;
  }
}

function engineMissingHint(name) {
  return `计算引擎缺失：没找到 dist/engine-ts/${name}。请重新安装程序，或在源码目录运行 npm run build:engine-ts 后重试。`;
}

/**
 * @param {{dbPath?: string, mode?: "calculate"|"check"|"update"}} opts
 */
function createEngine({ dbPath } = {}) {
  if (!bundleReady("worker.mjs")) throw new Error(engineMissingHint("worker.mjs"));
  const isolated = engineConfig.isEngineIsolated();
  if (isolated) {
    const { EngineChildProcess } = require("./engine-child");
    if (!bundleReady("child.mjs")) throw new Error(engineMissingHint("child.mjs"));
    return new EngineChildProcess({ dbPath });
  }
  const { EngineTsProcess } = require("./engine-ts-worker");
  return new EngineTsProcess({ dbPath });
}

module.exports = { createEngine };
