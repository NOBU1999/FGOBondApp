/**
 * meta 领域：app_meta 键值表 + 由它派生的设置项
 *
 * 共用层（跨平台）：只通过注入的 sql 端口访问数据，不含任何平台代码。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export function createMetaDomain({ sql }) {
  function getMetaValue(key) {
    const row = sql.get("SELECT value FROM app_meta WHERE key = ?", [key]);
    return row ? row.value : null;
  }

  function setMetaValue(key, value) {
    sql.run("INSERT OR REPLACE INTO app_meta(key, value) VALUES (?, ?)", [key, String(value)]);
  }

  function getCnUnavailableBondCeIds() {
    try {
      const raw = getMetaValue("cn_unavailable_bond_ce_ids");
      const list = JSON.parse(raw || "[]");
      return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
    } catch (_) {
      return [];
    }
  }

  function getServerRegion() {
    const raw = getMetaValue("server_region");
    return raw === "cn" ? "cn" : "jp";
  }

  function setServerRegion(region) {
    setMetaValue("server_region", region === "cn" ? "cn" : "jp");
  }

  function getGenericBondParticipation() {
    try {
      const raw = getMetaValue("generic_bond_participation");
      const list = JSON.parse(raw || "[]");
      return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
    } catch (_) {
      return [];
    }
  }

  function setGenericBondParticipation(ids) {
    const list = Array.from(new Set((ids || []).map(Number))).filter((n) => Number.isFinite(n));
    setMetaValue("generic_bond_participation", JSON.stringify(list));
    return getGenericBondParticipation();
  }

  function getNonParticipatingCraftIds() {
    try {
      const raw = getMetaValue("non_participating_craft_ids");
      const list = JSON.parse(raw || "[]");
      return Array.isArray(list) ? list.map(Number).filter((n) => Number.isFinite(n)) : [];
    } catch (_) {
      return [];
    }
  }

  function setNonParticipatingCraftIds(ids) {
    const list = Array.from(new Set((ids || []).map(Number))).filter((n) => Number.isFinite(n));
    setMetaValue("non_participating_craft_ids", JSON.stringify(list));
    return getNonParticipatingCraftIds();
  }

  return {
    getMetaValue,
    setMetaValue,
    getCnUnavailableBondCeIds,
    getServerRegion,
    setServerRegion,
    getGenericBondParticipation,
    setGenericBondParticipation,
    getNonParticipatingCraftIds,
    setNonParticipatingCraftIds,
  };
}
