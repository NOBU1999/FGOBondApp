"use strict";

const { ipcMain, BrowserWindow } = require("electron");
const database = require("./database");
const { PythonProcess } = require("./python-process");
const { getAppRoot, getDbPath } = require("./paths");

let activeEngine = null;

function stopActiveEngine() {
  if (activeEngine) {
    activeEngine.stop();
    activeEngine = null;
  }
}

function sendProgress(event, text) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.webContents.send("engine-progress", { message: text, timestamp: Date.now() });
  }
}

function registerIpcHandlers() {
  // 应用基本信息
  ipcMain.handle("app:get-info", () => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return {
        appRoot: getAppRoot(),
        dbPath: getDbPath(),
        version: require("../package.json").version,
        platform: process.platform,
        serverRegion: database.getServerRegion(db),
        cnUnavailableBondCeIds: database.getCnUnavailableBondCeIds(db),
        genericParticipatingCraftIds: database.getGenericBondParticipation(db),
      };
    } finally {
      db.close();
    }
  });

  // 服务器设置（日服/简中服）
  ipcMain.handle("app:set-server-region", (_e, region) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      database.setServerRegion(db, region === "cn" ? "cn" : "jp");
      return database.getServerRegion(db);
    } finally {
      db.close();
    }
  });

  // 通用礼装是否参与自动搜索
  ipcMain.handle("app:set-generic-participation", (_e, ids) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      database.setGenericBondParticipation(db, ids || []);
      return database.getGenericBondParticipation(db);
    } finally {
      db.close();
    }
  });

  // ---------------- DB 查询 ----------------
  ipcMain.handle("db:list-servants", () => {
    const db = database.open();
    try {
      return database.listServants(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("db:get-servant", (_e, servantId) => {
    const db = database.open();
    try {
      return database.getServant(db, servantId);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("db:get-stage-traits", (_e, servantId, stage, region) => {
    const db = database.open();
    try {
      return database.getStageTraits(db, servantId, stage, region);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("db:get-all-stage-traits", (_e, servantId, region) => {
    const db = database.open();
    try {
      return database.getAllStageTraits(db, servantId, region);
    } finally {
      db.close();
    }
  });

  // 灵衣名称：从 DB 读取，随“更新数据”自动刷新
  ipcMain.handle("app:costume-names", () => {
    const db = database.open();
    try {
      return database.getCostumeNames(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("exclusion:get", () => {
    const db = database.open();
    try {
      return database.getExclusions(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("exclusion:save", (_e, exclusions) => {
    const db = database.open();
    try {
      database.saveExclusions(db, exclusions || {});
      return database.getExclusions(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("custom:list", () => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.listCustomCrafts(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("custom:save", (_e, items) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.saveCustomCrafts(db, items || []);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("import:capture", (_e, content) => {
    const db = database.open();
    try {
      return database.importCaptureContent(db, content);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("db:list-bond-crafts", () => {
    const db = database.open();
    try {
      return database.listCrafts(db, true);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("db:list-all-crafts", () => {
    const db = database.open();
    try {
      return database.listCrafts(db, false);
    } finally {
      db.close();
    }
  });

  // ---------------- 用户 Box / 队伍 ----------------
  ipcMain.handle("user:get-box", () => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.getUserBox(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("user:save-box", (_e, entries) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.saveUserBox(db, entries);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("user:reset-box", () => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.resetUserBox(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("user:list-teams", () => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.listUserTeams(db);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("user:save-team", (_e, team) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.saveUserTeam(db, team);
    } finally {
      db.close();
    }
  });

  ipcMain.handle("user:delete-team", (_e, id) => {
    const db = database.open();
    try {
      database.ensureSchema(db);
      return database.deleteUserTeam(db, id);
    } finally {
      db.close();
    }
  });

  // 活动牵绊加成表（由 Python 更新生成 db/event_bond_bonus.json）
  ipcMain.handle("event:list", () => {
    return database.getEventBondBonuses();
  });

  // ---------------- Python 引擎 ----------------
  ipcMain.handle("engine:calculate", async (event, payload) => {
    stopActiveEngine();
    const engine = new PythonProcess({ dbPath: getDbPath() });
    activeEngine = engine;
    engine.on("progress", (text) => sendProgress(event, text));
    try {
      const result = await engine.calculate(payload);
      return result;
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
      return result;
    } finally {
      if (activeEngine === engine) activeEngine = null;
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
};
