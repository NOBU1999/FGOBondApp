"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Electron IPC 使用 structured clone；Vue 的 reactive Proxy 无法被克隆。
// 所有从 renderer 传入主进程的参数统一先转成普通 JSON 数据再发送。
function toPlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

contextBridge.exposeInMainWorld("fgo", {
  // 基础信息
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  setServerRegion: (region) => ipcRenderer.invoke("app:set-server-region", toPlain(region)),
  setGenericBondParticipation: (ids) => ipcRenderer.invoke("app:set-generic-participation", toPlain(ids)),
  setNonParticipatingCraftIds: (ids) => ipcRenderer.invoke("app:set-non-participating-crafts", toPlain(ids)),
  getCostumeNames: () => ipcRenderer.invoke("app:costume-names"),

  // 数据查询
  listServants: (region) => ipcRenderer.invoke("db:list-servants", toPlain(region)),
  getServant: (id) => ipcRenderer.invoke("db:get-servant", toPlain(id)),
  getStageTraits: (id, stage, region) => ipcRenderer.invoke("db:get-stage-traits", toPlain(id), toPlain(stage), toPlain(region)),
  getAllStageTraits: (id, region) => ipcRenderer.invoke("db:get-all-stage-traits", toPlain(id), toPlain(region)),
  listBondCrafts: () => ipcRenderer.invoke("db:list-bond-crafts"),
  listAllCrafts: () => ipcRenderer.invoke("db:list-all-crafts"),

  // 用户 Box / 队伍
  getUserBox: () => ipcRenderer.invoke("user:get-box"),
  saveUserBox: (entries) => ipcRenderer.invoke("user:save-box", toPlain(entries)),
  resetUserBox: () => ipcRenderer.invoke("user:reset-box"),
  importCapture: (content) => ipcRenderer.invoke("import:capture", toPlain(content)),
  getExclusions: () => ipcRenderer.invoke("exclusion:get"),
  saveExclusions: (exclusions) => ipcRenderer.invoke("exclusion:save", toPlain(exclusions)),
  listCustomCrafts: () => ipcRenderer.invoke("custom:list"),
  saveCustomCrafts: (items) => ipcRenderer.invoke("custom:save", toPlain(items)),
  listUserTeams: () => ipcRenderer.invoke("user:list-teams"),
  saveUserTeam: (team) => ipcRenderer.invoke("user:save-team", toPlain(team)),
  deleteUserTeam: (id) => ipcRenderer.invoke("user:delete-team", toPlain(id)),
  getEventBondBonuses: () => ipcRenderer.invoke("event:list"),

  // Python 引擎
  calculate: (payload) => ipcRenderer.invoke("engine:calculate", toPlain(payload)),
  updateData: (force = false) => ipcRenderer.invoke("engine:update", toPlain({ force })),
  cancelEngine: () => ipcRenderer.invoke("engine:cancel"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", toPlain(text)),

  // 主进程推送事件
  onEngineProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("engine-progress", listener);
    return () => ipcRenderer.removeListener("engine-progress", listener);
  },
  onMenuAction: (callback) => {
    const channels = ["menu:settings", "menu:update-data", "menu:update-data-force", "menu:reset-database"];
    const listeners = channels.map((channel) => {
      const listener = (_event, data) => callback(Object.assign({}, data || {}, { channel }));
      ipcRenderer.on(channel, listener);
      return [channel, listener];
    });
    return () => {
      for (const [channel, listener] of listeners) {
        ipcRenderer.removeListener(channel, listener);
      }
    };
  },
});
