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

/**
 * 返回 Python 引擎启动信息。
 * 优先使用打包后的 engine.exe；开发模式若不存在则退回 python + engine_launcher.py。
 */
function getEngineLaunchInfo() {
  const exePath = path.join(getAppRoot(), "python-engine", "engine.exe");
  const launcher = path.join(getAppRoot(), "python-engine", "engine_launcher.py");

  // 开发模式优先使用 Python 源码，避免每次改 Python 代码都要重新打包
  if (!isPackaged() && fs.existsSync(launcher)) {
    return { type: "python", path: launcher };
  }
  if (fs.existsSync(exePath)) {
    return { type: "exe", path: exePath };
  }
  if (fs.existsSync(launcher)) {
    return { type: "python", path: launcher };
  }

  throw new Error("未找到 Python 计算引擎，请检查 python-engine/engine.exe 是否存在");
}

module.exports = {
  getAppRoot,
  getDbPath,
  getEngineLaunchInfo,
};
