/**
 * customCrafts 领域：用户自定义礼装（全局，不按账号隔离）
 *
 * 共用层（跨平台）：只通过注入的 sql 端口访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export function createCustomCraftsDomain({ sql }) {
  function listCustomCrafts() {
    const rows = sql.all(
      "SELECT id, name, craft_type AS craftType, cost, rarity, percent_bonus AS percentBonus, flat_bonus AS flatBonus, condition_groups_json AS conditionGroupsJson, repeatable, enabled FROM custom_crafts ORDER BY id"
    );
    for (const r of rows) {
      try {
        r.conditionGroups = JSON.parse(r.conditionGroupsJson || "[]");
      } catch (_) {
        r.conditionGroups = [];
      }
      delete r.conditionGroupsJson;
      r.percentBonus = Number(r.percentBonus || 0);
      r.flatBonus = Number(r.flatBonus || 0);
      r.repeatable = !!r.repeatable;
      r.enabled = !!r.enabled;
    }
    return rows;
  }

  function saveCustomCrafts(items) {
    sql.tx(() => {
      sql.exec("DELETE FROM custom_crafts");
      const insertSql = `INSERT INTO custom_crafts
        (id, name, craft_type, cost, rarity, percent_bonus, flat_bonus,
         condition_groups_json, repeatable, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      for (const item of items || []) {
        const id = Number(item.id);
        const row = [
          Number.isFinite(id) && id > 0 ? id : null,
          String(item.name || "").trim(),
          item.craftType === "other" ? "other" : "bond",
          Math.max(0, Math.round(Number(item.cost || 0))),
          Math.max(0, Math.round(Number(item.rarity || 0))),
          Number(item.percentBonus || 0),
          Number(item.flatBonus || 0),
          JSON.stringify(Array.isArray(item.conditionGroups) ? item.conditionGroups : []),
          item.repeatable ? 1 : 0,
          item.enabled === false ? 0 : 1,
        ];
        sql.run(insertSql, row);
      }
    });
    return listCustomCrafts();
  }

  return { listCustomCrafts, saveCustomCrafts };
}
