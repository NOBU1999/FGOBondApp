"use strict";

const fs = require("fs");
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

function getDbPath() {
  return path.join(getAppRoot(), "db", "fgo_data.db");
}

module.exports = {
  getAppRoot,
  getDbPath,
};
