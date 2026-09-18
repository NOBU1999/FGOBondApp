/**
 * 桥接层（界面 ↔ 宿主）的**共用语义**
 *
 * 用途：把 `window.fgo.*` 那 36 个方法里"平台无关的那部分语义"集中到这里，
 * 让 Windows（Electron ipc-handlers）与安卓（WebView boot）**共用同一份实现**，避免分叉。
 *
 * 语义来源：v0.1.10 的 main/ipc-handlers.js（阶段 5 抽出，逐行等价）。
 * 各平台的差异只在这三处，通过 `platform` 参数注入：
 *   1. getAppInfo 里的 appRoot / dbPath / version / platform 等平台字段
 *   2. 活动加成表（桌面读 db 同目录的 event_bond_bonus.json；安卓随包或返回空）
 *   3. 剪贴板、引擎、进度事件（不在本模块，属平台能力）
 *
 * 契约文档：shared/contracts/bridge-surface.md（v1）
 */

export function createDataBridge({ domain, platform = {} }) {
  const { meta, accounts, box, exclusions, customCrafts, teams, staticData } = domain;

  const P = {
    appRoot: platform.appRoot ?? null,
    dbPath: platform.dbPath ?? null,
    version: platform.version ?? "",
    platformName: platform.platformName ?? "unknown",
    getEventBondBonuses: platform.getEventBondBonuses || (() => []),
  };

  return {
    // ---------------- 应用信息 ----------------
    getAppInfo: () => ({
      appRoot: P.appRoot,
      dbPath: P.dbPath,
      version: P.version,
      platform: P.platformName,
      dataUpdatedAt: meta.getMetaValue("updated_at"),
      dataRegion: meta.getMetaValue("data_region"),
      serverRegion: meta.getServerRegion(),
      cnUnavailableBondCeIds: meta.getCnUnavailableBondCeIds(),
      genericParticipatingCraftIds: meta.getGenericBondParticipation(),
      nonParticipatingCraftIds: meta.getNonParticipatingCraftIds(),
      activeAccount: accounts.getActiveAccount(),
    }),

    // ---------------- 多账号 ----------------
    listAccounts: () => accounts.listAccounts(),
    createAccount: (payload = {}) => accounts.createAccount(payload.name, { copyFromId: payload.copyFromId }),
    renameAccount: (payload = {}) => accounts.renameAccount(payload.id, payload.name),
    duplicateAccount: (payload = {}) => accounts.duplicateAccount(payload.id, payload.name),
    deleteAccount: (id) => accounts.deleteAccount(id),
    setActiveAccount: (id) => accounts.setActiveAccount(id),

    // ---------------- 设置 ----------------
    setServerRegion: (region) => {
      meta.setServerRegion(region === "cn" ? "cn" : "jp");
      return { serverRegion: meta.getServerRegion() };
    },
    setGenericBondParticipation: (ids) => {
      meta.setGenericBondParticipation(ids || []);
      return meta.getGenericBondParticipation();
    },
    setNonParticipatingCraftIds: (ids) => {
      meta.setNonParticipatingCraftIds(ids || []);
      return meta.getNonParticipatingCraftIds();
    },

    // ---------------- 静态数据 ----------------
    // 注意：界面调用 listServants() 时可能不传区服 → 用当前设置的区服（与旧 ipc-handlers 一致）
    listServants: (region) => staticData.listServants(region || meta.getServerRegion()),
    getServant: (servantId) => staticData.getServant(servantId),
    getStageTraits: (servantId, stage, region) => staticData.getStageTraits(servantId, stage, region),
    getAllStageTraits: (servantId, region) => staticData.getAllStageTraits(servantId, region),
    getCostumeNames: () => staticData.getCostumeNames(),
    listBondCrafts: () => staticData.listCrafts(true),
    listAllCrafts: () => staticData.listCrafts(false),
    getEventBondBonuses: () => P.getEventBondBonuses(),

    // ---------------- Box ----------------
    getUserBox: (accountId) => box.getUserBox(accountId),
    saveUserBox: (entries, accountId) => box.saveUserBox(entries, accountId),
    resetUserBox: (accountId) => box.resetUserBox(accountId),
    importCapture: (content, accountId) => box.importCaptureContent(content, accountId),

    // ---------------- 排除名单 ----------------
    getExclusions: (accountId) => exclusions.getExclusions(accountId),
    saveExclusions: (list, accountId) => exclusions.saveExclusions(list || {}, accountId),

    // ---------------- 自定义礼装 ----------------
    listCustomCrafts: () => customCrafts.listCustomCrafts(),
    saveCustomCrafts: (items) => customCrafts.saveCustomCrafts(items || []),

    // ---------------- 队伍预设 ----------------
    listUserTeams: () => teams.listUserTeams(),
    saveUserTeam: (team) => teams.saveUserTeam(team),
    deleteUserTeam: (id) => teams.deleteUserTeam(id),
  };
}

/** 会改数据的桥接方法名（宿主据此决定是否持久化 / 是否需要事务） */
export const WRITE_METHODS = new Set([
  "createAccount",
  "renameAccount",
  "duplicateAccount",
  "deleteAccount",
  "setActiveAccount",
  "setServerRegion",
  "setGenericBondParticipation",
  "setNonParticipatingCraftIds",
  "saveUserBox",
  "resetUserBox",
  "importCapture",
  "saveExclusions",
  "saveCustomCrafts",
  "saveUserTeam",
  "deleteUserTeam",
]);
