"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Electron IPC 使用 structured clone；Vue 的 reactive Proxy 无法被克隆。
// 所有从 renderer 传入主进程的参数统一先转成普通 JSON 数据再发送。
function toPlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 数据方法：与共用桥接层 shared/bridge/data-bridge.mjs 的 BRIDGE_METHOD_NAMES 一一对应，
// 通道名统一是 data:<方法名>。清单一致性由 `npm run test:contracts` 的 surface 套件核对
// （安卓端同一份清单在 platforms/android/web-host/boot.js）。
// ---------------------------------------------------------------------------
const DATA_METHODS = [
  "getAppInfo",
  "setServerRegion",
  "setGenericBondParticipation",
  "setNonParticipatingCraftIds",
  "getCostumeNames",
  "listServants",
  "getServant",
  "getStageTraits",
  "getAllStageTraits",
  "listBondCrafts",
  "listAllCrafts",
  "getUserBox",
  "saveUserBox",
  "resetUserBox",
  "importCapture",
  "getExclusions",
  "saveExclusions",
  "listCustomCrafts",
  "saveCustomCrafts",
  "listUserTeams",
  "saveUserTeam",
  "deleteUserTeam",
  "getEventBondBonuses",
  "listAccounts",
  "createAccount",
  "renameAccount",
  "duplicateAccount",
  "deleteAccount",
  "setActiveAccount",
];

const dataApi = {};
for (const name of DATA_METHODS) {
  dataApi[name] = (...args) => ipcRenderer.invoke(`data:${name}`, ...args.map(toPlain));
}

contextBridge.exposeInMainWorld("fgo", {
  ...dataApi,

  // 平台能力（各平台自己实现；清单见 shared/bridge/surface.mjs）
  calculate: (payload) => ipcRenderer.invoke("engine:calculate", toPlain(payload)),
  updateData: (force = false) => ipcRenderer.invoke("engine:update", toPlain({ force })),
  resetStaticData: () => ipcRenderer.invoke("db:reset-static"),
  cancelEngine: () => ipcRenderer.invoke("engine:cancel"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", toPlain(text)),
  ensureAvatars: () => ipcRenderer.invoke("avatars:ensure"),
  getAvatarData: (id) => ipcRenderer.invoke("avatars:data", toPlain(id)),
  getDiagnosticLog: () => ipcRenderer.invoke("log:read"),
  clearDiagnosticLog: () => ipcRenderer.invoke("log:clear"),

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
