"use strict";

/**
 * 引擎入口。**只有 TypeScript 一种实现**（v0.3.0 起默认，v0.3.1 起 Python 侧已从仓库移除）。
 *
 * 计算 / check / update 全部走 `dist/engine-ts/worker.mjs`（`worker_threads`）。
 * 产物缺失时**直接报错**，不再回退到别的实现 —— 免得用户看到"缺文件"这种二手错误。
 *
 * 对外接口（与旧实现一致）：calculate / check / update / stop / stderrTail / progress 事件。
 */
const fs = require("fs");
const path = require("path");
const { getAppRoot } = require("./paths");

/** 引擎产物在不在（`npm run build:engine-ts` 生成；源码 clone 后没跑过就没有） */
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
function createEngine({ dbPath } = {}) {
  if (!tsBundleReady()) {
    throw new Error(
      "计算引擎缺失：没找到 dist/engine-ts/worker.mjs。请重新安装程序，或在源码目录运行 npm run build:engine-ts 后重试。",
    );
  }
  const { EngineTsProcess } = require("./engine-ts-worker");
  return new EngineTsProcess({ dbPath });
}

module.exports = { createEngine };
