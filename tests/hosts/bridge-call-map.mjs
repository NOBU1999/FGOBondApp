/**
 * 契约用例 → 桥接层方法的映射（桌面 / 安卓两个宿主适配器共用）
 *
 * 用途：让同一批 bridge-cases.json 用例直接跑在 `shared/bridge/data-bridge.mjs` 上
 * （也就是重构后 Windows main/ipc-handlers.js 与安卓 boot.js 真正使用的那一层），
 * 而不是只跑领域层 façade。
 *
 * 为什么需要映射：用例是按**领域层**方法名写的（`accounts.listAccounts`），
 * 而桥接层把「账号类」收在同一个对象上并收窄了参数（`listAccounts()`、
 * `createAccount({name, copyFromId})`）。映射表如实记录这层对应关系。
 */

export const BRIDGE_CALL_ROUTES = {
  // ---------------- 账号 ----------------
  "accounts.listAccounts": (b) => b.listAccounts(),
  "accounts.createAccount": (b, a) => b.createAccount({ name: a[0], copyFromId: a[1] && a[1].copyFromId }),
  "accounts.renameAccount": (b, a) => b.renameAccount({ id: a[0], name: a[1] }),
  "accounts.duplicateAccount": (b, a) => b.duplicateAccount({ id: a[0], name: a[1] }),
  "accounts.deleteAccount": (b, a) => b.deleteAccount(a[0]),
  "accounts.setActiveAccount": (b, a) => b.setActiveAccount(a[0]),

  // ---------------- 设置 / 元信息 ----------------
  "meta.setServerRegion": (b, a) => b.setServerRegion(a[0]),
  // 桥接层只在 getAppInfo 里暴露当前区服（桌面/安卓界面都是这么用的）
  "meta.getServerRegion": (b) => b.getAppInfo().serverRegion,
  "meta.setGenericBondParticipation": (b, a) => b.setGenericBondParticipation(a[0]),
  "meta.setNonParticipatingCraftIds": (b, a) => b.setNonParticipatingCraftIds(a[0]),

  // ---------------- 静态数据 ----------------
  "staticData.listServants": (b, a) => b.listServants(a[0]),
  "staticData.getServant": (b, a) => b.getServant(a[0]),
  "staticData.getStageTraits": (b, a) => b.getStageTraits(a[0], a[1], a[2]),
  "staticData.getAllStageTraits": (b, a) => b.getAllStageTraits(a[0], a[1]),
  "staticData.getCostumeNames": (b) => b.getCostumeNames(),
  "staticData.listCrafts": (b, a) => (a[0] ? b.listBondCrafts() : b.listAllCrafts()),

  // ---------------- Box ----------------
  "box.getUserBox": (b, a) => b.getUserBox(a[0]),
  "box.saveUserBox": (b, a) => b.saveUserBox(a[0], a[1]),
  "box.resetUserBox": (b, a) => b.resetUserBox(a[0]),
  "box.importCaptureContent": (b, a) => b.importCapture(a[0], a[1]),

  // ---------------- 排除名单 ----------------
  "exclusions.getExclusions": (b, a) => b.getExclusions(a[0]),
  "exclusions.saveExclusions": (b, a) => b.saveExclusions(a[0], a[1]),

  // ---------------- 自定义礼装 ----------------
  "customCrafts.listCustomCrafts": (b) => b.listCustomCrafts(),
  "customCrafts.saveCustomCrafts": (b, a) => b.saveCustomCrafts(a[0]),

  // ---------------- 队伍预设 ----------------
  "teams.listUserTeams": (b) => b.listUserTeams(),
  "teams.saveUserTeam": (b, a) => b.saveUserTeam(a[0]),
  "teams.deleteUserTeam": (b, a) => b.deleteUserTeam(a[0]),

  // ---------------- 平台能力（宿主专属用例） ----------------
  "platform.getAppInfo": (b) => b.getAppInfo(),
  "platform.getEventBondBonuses": (b) => b.getEventBondBonuses(),
};

/** 跑一条用例；找不到映射直接报错（免得静默跳过） */
export function callBridgeRoute(bridge, group, fn, args = []) {
  const key = `${group}.${fn}`;
  const route = BRIDGE_CALL_ROUTES[key];
  if (!route) throw new Error(`桥接适配器没有映射 ${key}`);
  return route(bridge, args);
}
