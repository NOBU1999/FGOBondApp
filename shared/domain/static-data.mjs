/**
 * staticData 领域：游戏静态数据查询（只读）
 *
 * 共用层（跨平台）：只通过注入的 sql 端口访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 *
 * 注意：这些查询直接读 Python 引擎写入的表（servants / crafts / 特性 / 灵衣），
 * 表结构由引擎侧负责，这里只读不写。
 */

export function createStaticDataDomain({ sql }) {
  function listServants(region) {
    // 剔除 collection_no<=0 的非常规/未实装/重复从者（如未来实装角色），
    // 避免在 Box/排除/选择界面显示 0 号条目。
    const rows = sql.all(
      "SELECT id, collection_no AS collectionNo, name, class, cost, rarity, atk_max AS atkMax, hp_max AS hpMax, type FROM servants WHERE collection_no > 0 ORDER BY collection_no"
    );
    // 简中服模式只展示简中服已实装的灵衣
    const costumeTable = region === "cn" ? "servant_costume_traits_cn" : "servant_costume_traits";
    const costumeRows = sql.all(
      `SELECT DISTINCT servant_id AS servantId, costume_id AS costumeId FROM ${costumeTable} ORDER BY servant_id, costume_id`
    );
    const costumeMap = {};
    for (const r of costumeRows) {
      if (!costumeMap[r.servantId]) costumeMap[r.servantId] = [];
      costumeMap[r.servantId].push(r.costumeId);
    }
    for (const r of rows) {
      r.costumes = costumeMap[r.id] || [];
    }
    return rows;
  }

  function getCostumeNames() {
    const rows = sql.all("SELECT costume_id AS costumeId, name FROM servant_costumes WHERE name <> ''");
    const result = {};
    for (const r of rows) result[String(r.costumeId)] = r.name;
    return result;
  }

  function getServant(servantId) {
    return sql.get(
      "SELECT id, collection_no AS collectionNo, name, class, cost, rarity, atk_max AS atkMax, hp_max AS hpMax, type FROM servants WHERE id = ?",
      [servantId]
    );
  }

  /**
   * 特性表选择器。
   * - `"jp"`：主表；`"cn"`：国服表（缺行回退主表）；`"pillar"`：终章柱子战的**冻结表**
   *   （国服特性的一次性快照 + 所罗门，入库后不随数据更新变化；老库没有该表时退回国服）。
   */
  function traitTables(region) {
    if (region === "pillar") {
      return { stage: "pillar_stage_traits", costume: "pillar_costume_traits", fallback: false };
    }
    if (region === "cn") {
      return { stage: "servant_stage_traits_cn", costume: "servant_costume_traits_cn", fallback: true };
    }
    return { stage: "servant_stage_traits", costume: "servant_costume_traits", fallback: false };
  }

  function getStageTraits(servantId, stage, region) {
    const st = String(stage || "fourth");
    let sel = traitTables(region);
    const query = (table, extra) => {
      if (st.startsWith("costume_")) {
        const costumeId = Number(st.split("_")[1]);
        if (!Number.isFinite(costumeId)) return [];
        return sql
          .all(
            `SELECT trait FROM ${table} WHERE servant_id = ? AND costume_id = ? AND trait <> 'unknown' ORDER BY trait`,
            [servantId, costumeId]
          )
          .map((r) => r.trait);
      }
      return sql
        .all(
          `SELECT trait FROM ${table} WHERE servant_id = ? AND stage = ? AND trait <> 'unknown' ORDER BY trait`,
          [servantId, st]
        )
        .map((r) => r.trait);
    };
    let rows;
    try {
      rows = query(st.startsWith("costume_") ? sel.costume : sel.stage);
    } catch (err) {
      // 冻结表不存在（老库）⇒ 退回国服表
      if (region !== "pillar") throw err;
      sel = traitTables("cn");
      rows = query(st.startsWith("costume_") ? sel.costume : sel.stage);
    }
    if (rows.length) return rows;
    if (sel.fallback) return query(st.startsWith("costume_") ? "servant_costume_traits" : "servant_stage_traits");
    return [];
  }

  function getAllStageTraits(servantId, region) {
    let sel = traitTables(region);
    const read = (table) => {
      const rows = sql.all(
        `SELECT stage, trait FROM ${table} WHERE servant_id = ? AND trait <> 'unknown' ORDER BY stage, trait`,
        [servantId]
      );
      const out = {};
      for (const r of rows) {
        if (!out[r.stage]) out[r.stage] = [];
        out[r.stage].push(r.trait);
      }
      return out;
    };
    let result;
    try {
      result = read(sel.stage);
    } catch (err) {
      if (region !== "pillar") throw err;
      sel = traitTables("cn");
      result = read(sel.stage);
    }
    if (!Object.keys(result).length && sel.fallback) result = read("servant_stage_traits");
    return result;
  }

  function listCrafts(bondOnly = false) {
    const sqlText = bondOnly
      ? "SELECT id, collection_no AS collectionNo, name, cost, rarity, bonus_type AS bonusType, bonus_value AS bonusValue, support_bonus AS supportBonus, trigger_traits_json AS triggerTraitsJson, detail, is_bond_ce AS isBondCe, is_event_limited AS isEventLimited FROM crafts WHERE is_bond_ce = 1 ORDER BY collection_no"
      : "SELECT id, collection_no AS collectionNo, name, cost, rarity, bonus_type AS bonusType, bonus_value AS bonusValue, support_bonus AS supportBonus, trigger_traits_json AS triggerTraitsJson, detail, is_bond_ce AS isBondCe, is_event_limited AS isEventLimited FROM crafts ORDER BY collection_no";
    const rows = sql.all(sqlText);
    // 用户可见分类只保留两类：牵绊礼装 / 其他礼装
    for (const r of rows) {
      r.craftType = r.isBondCe ? "bond" : "other";
    }
    return rows;
  }

  return { listServants, getCostumeNames, getServant, getStageTraits, getAllStageTraits, listCrafts };
}
