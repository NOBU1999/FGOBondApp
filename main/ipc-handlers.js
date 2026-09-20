"use strict";

const { ipcMain, BrowserWindow, clipboard } = require("electron");
const database = require("./database");
const { PythonProcess } = require("./python-process");
const { getAppRoot, getDbPath } = require("./paths");
const { resetStaticData } = require("./db-reset");
const { diagLog, tailOf, readDiagLog, clearDiagLog } = require("./diag-log");
const avatars = require("./avatars");
const { createDataBridge, BRIDGE_METHOD_NAMES } = require("../shared/bridge/data-bridge.mjs");

let activeEngine = null;

function stopActiveEngine() {
  if (activeEngine) {
    activeEngine.stop();
    activeEngine = null;
  }
}

/** 引擎失败时记日志：错误信息 + 引擎输出尾部（用户反馈时能看到真正原因） */
function logEngineFailure(what, err, engine) {
  const message = (err && err.message) || String(err);
  const tail = engine ? engine.stderrTail : "";
  diagLog(`${what}失败：${message}${tail ? `\n--- 引擎输出尾部 ---\n${tailOf(tail)}` : ""}`);
}

/** 运行时补齐缺失头像：失败只提示，绝不打断更新数据 */
async function backfillAvatars(event) {
  try {
    const result = await avatars.ensureAvatars({
      onProgress: (done, total) => sendProgress(event, `正在补齐缺失头像 ${done}/${total}`),
    });
    if (result.fetched) sendProgress(event, `已补齐缺失头像 ${result.fetched} 张`);
    if (result.failed.length) {
      sendProgress(event, `有 ${result.failed.length} 张头像没下到（不影响使用）`);
    }
    return result;
  } catch (err) {
    diagLog(`补齐缺失头像流程出错：${(err && err.message) || err}`);
    return null;
  }
}

function sendProgress(event, text) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.webContents.send("engine-progress", { message: text, timestamp: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// 数据方法：统一交给共用桥接层（与安卓同一份语义）
//   实现见 shared/bridge/data-bridge.mjs，名字来自 BRIDGE_METHOD_NAMES（由实现推导，不会走偏）
//   平台差异只通过 platform 参数注入（路径 / 版本 / 区服无关的那点东西）
// ---------------------------------------------------------------------------

/** 平台字段注入：桌面能提供的那些（安卓对应 boot.js 里的 platform 对象） */
function desktopPlatform() {
  return {
    appRoot: getAppRoot(),
    dbPath: getDbPath(),
    version: require("../package.json").version,
    platformName: process.platform === "win32" ? "windows" : process.platform,
    getEventBondBonuses: () => database.getEventBondBonuses(getDbPath()),
  };
}

/**
 * 纯静态数据读取：只读「更新数据」建好的表，不必每次跑一遍建表检查（省几十毫秒）
 * 其余方法照旧先 ensureSchema（含坏库自愈 / 旧结构迁移）。
 */
const SKIP_SCHEMA_METHODS = new Set([
  "listServants",
  "getServant",
  "getStageTraits",
  "getAllStageTraits",
  "getCostumeNames",
  "listBondCrafts",
  "listAllCrafts",
  "getEventBondBonuses",
]);

/** 每次调用开一次库（与重构前一致）：打开 → 建表 → 跑桥接方法 → 关库 */
async function withDataBridge(name, run) {
  const db = database.open(getDbPath());
  try {
    if (!SKIP_SCHEMA_METHODS.has(name)) database.ensureSchema(db);
    const bridge = createDataBridge({ domain: database.getDomain(db), platform: desktopPlatform() });
    // await：桥接方法里可能有异步（例如读活动牵绊表），要等它完成再关库
    return await run(bridge);
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 注册数据方法通道：data:<方法名>（与 preload.js 里的调用名一一对应） */
function registerDataChannels() {
  for (const name of BRIDGE_METHOD_NAMES) {
    ipcMain.handle(`data:${name}`, async (_event, ...args) =>
      withDataBridge(name, (bridge) => bridge[name](...args))
    );
  }
}

function registerIpcHandlers() {
  registerDataChannels();

  // ---------------- 平台能力：剪贴板 ----------------
  ipcMain.handle("clipboard:write", (_e, text) => {
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  });

  // ---------------- 平台能力：诊断日志（界面「诊断日志」面板） ----------------
  ipcMain.handle("log:read", () => readDiagLog());
  ipcMain.handle("log:clear", () => clearDiagLog());

  // ---------------- Python 引擎 ----------------
  ipcMain.handle("engine:calculate", async (event, payload) => {
    stopActiveEngine();
    const engine = new PythonProcess({ dbPath: getDbPath() });
    activeEngine = engine;
    engine.on("progress", (text) => sendProgress(event, text));
    try {
      const result = await engine.calculate(payload);
      return result;
    } catch (err) {
      logEngineFailure("引擎计算", err, engine);
      throw err;
    } finally {
      if (activeEngine === engine) activeEngine = null;
    }
  });

  ipcMain.handle("engine:update", async (event, options = {}) => {
    stopActiveEngine();
    const engine = new PythonProcess({ dbPath: getDbPath() });
    activeEngine = engine;
    engine.on("progress", (text) => sendProgress(event, text));
    try {
      const result = await engine.update(Boolean(options && options.force));
      diagLog(`数据更新结束：status=${result && result.status} updated=${result && result.updated}`);
      // 顺手补齐新从者的头像（下载失败只提示，不影响更新数据本身）
      const avatarResult = await backfillAvatars(event);
      if (result && typeof result === "object" && avatarResult) {
        result.avatars = {
          missing: avatarResult.missing,
          fetched: avatarResult.fetched,
          failed: avatarResult.failed.length,
        };
      }
      return result;
    } catch (err) {
      logEngineFailure("数据更新", err, engine);
      throw err;
    } finally {
      if (activeEngine === engine) activeEngine = null;
    }
  });

  // ---------------- 缺失头像（界面遇到坏图时单张补齐 / 批量补齐） ----------------
  ipcMain.handle("avatars:ensure", async (event) => backfillAvatars(event));

  ipcMain.handle("avatars:data", async (_event, id) => avatars.getAvatarData(id));

  // ---------------- 重置数据库（只重建静态数据，个人数据保留） ----------------
  ipcMain.handle("db:reset-static", async (event) => {
    stopActiveEngine();
    try {
      return await resetStaticData({
        onProgress: (text) => sendProgress(event, text),
      });
    } finally {
      stopActiveEngine();
    }
  });

  ipcMain.handle("engine:cancel", () => {
    stopActiveEngine();
    return { ok: true };
  });
}

module.exports = {
  registerIpcHandlers,
  stopActiveEngine,
  withDataBridge,
  desktopPlatform,
};
