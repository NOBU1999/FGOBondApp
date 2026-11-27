"use strict";

const path = require("path");

// ⚠️ electron 可选：纯 node 下（宿主层自检 / A/B 对拍）`require("electron")` 只返回可执行文件路径，
// 没有 app ⇒ 这里退化成"非打包态"，用 FGO_APP_ROOT 或仓库根定位。Electron 里行为完全不变。
let app = null;
try {
  const electron = require("electron");
  app = electron && electron.app ? electron.app : null;
} catch (_) {
  app = null;
}

function isPackaged() {
  return Boolean(app && app.isPackaged);
}

/**
 * 获取应用根目录：
 * - 便携目录版：exe 所在目录
 * - electron-builder portable 单 exe：PORTABLE_EXECUTABLE_DIR
 * - 开发模式：项目根目录
 */
function getAppRoot() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR;
  }
  if (isPackaged()) {
    return path.dirname(process.execPath);
  }
  if (process.env.FGO_APP_ROOT) {
    return process.env.FGO_APP_ROOT;
  }
  return path.join(__dirname, "..");
}

/** 数据目录（两个库、备份、头像、活动牵绊表都在这里） */
function getDataDir() {
  return path.join(getAppRoot(), "db");
}

/**
 * 个人数据库：账号 / Box / 排除 / 冠位名单 / 预设 / 自定义礼装 + 个人设置。
 * 这个文件**永远不进发布包**，升级不动它。
 */
function getDbPath() {
  return path.join(getDataDir(), "fgo_data.db");
}

/**
 * 游戏静态数据库：从者 / 礼装 / 特性 / 灵衣。随包发布，每次装新版整份替换。
 * 引擎（worker_threads / 安卓 Web Worker）读的就是这一个文件。
 */
function getGameDbPath() {
  return path.join(getDataDir(), "game.db");
}

module.exports = {
  getAppRoot,
  getDataDir,
  getDbPath,
  getGameDbPath,
};
