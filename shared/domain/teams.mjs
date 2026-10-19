/**
 * teams 领域：用户保存的队伍预设（全局，不按账号隔离）
 *
 * 共用层（跨平台）：只通过注入的 sql 端口访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export function createTeamsDomain({ sql }) {
  /**
   * 把一次计算结果挂到某个预设上（同一个预设只保留**最新一份**结果）。
   * 返回 { resultId, savedAt }。
   */
  function storeResult(teamId, payload = {}) {
    const id = Number(teamId);
    if (!id) throw new Error("保存结果需要有效的预设 id");
    const result = payload.result;
    if (result === undefined || result === null) throw new Error("没有可保存的计算结果");
    let resultJson;
    try {
      resultJson = typeof result === "string" ? result : JSON.stringify(result);
    } catch (_) {
      throw new Error("计算结果无法序列化");
    }
    let requestJson = null;
    if (payload.request !== undefined && payload.request !== null) {
      try {
        requestJson = typeof payload.request === "string" ? payload.request : JSON.stringify(payload.request);
      } catch (_) {
        requestJson = null;
      }
    }
    // 同预设只留最新一份：先删旧的（含被替换掉的那行），再挂新的
    const old = sql.get("SELECT result_id AS resultId FROM user_teams WHERE id = ?", [id]);
    if (old && old.resultId) sql.run("DELETE FROM saved_results WHERE id = ?", [Number(old.resultId)]);
    const info = sql.run(
      `INSERT INTO saved_results (team_id, data_revision, request_json, result_json, created_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [id, payload.dataRevision ? String(payload.dataRevision) : null, requestJson, resultJson]
    );
    const resultId = info.lastInsertRowid;
    sql.run("UPDATE user_teams SET result_id = ? WHERE id = ?", [resultId, id]);
    const row = sql.get("SELECT created_at AS savedAt FROM saved_results WHERE id = ?", [resultId]);
    return { resultId, savedAt: (row && row.savedAt) || null };
  }

  function saveUserTeam(team) {
    const supportCraftId =
      team.supportCraftId !== undefined && team.supportCraftId !== null ? team.supportCraftId : null;
    const supportSecondCraftId =
      team.supportSecondCraftId !== undefined && team.supportSecondCraftId !== null
        ? team.supportSecondCraftId
        : null;
    const info = sql.run(
      `INSERT INTO user_teams (name, fixed_servants, fixed_crafts, support_id, support_craft_id, support_second_craft_id, support_position, cost_limit, strategy, quality_mode, mode, crown_class, crown_positions, base_bond, neighborhood, search_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        team.name || "",
        JSON.stringify(team.fixedServants || []),
        JSON.stringify(team.fixedCrafts || []),
        team.supportId || null,
        supportCraftId,
        supportSecondCraftId,
        team.supportPosition || "front_right",
        team.costLimit || 116,
        team.strategy || "total_max",
        team.qualityMode || "balanced",
        team.mode || "normal",
        team.crownClass || "all",
        JSON.stringify(team.crownPositions || []),
        Number(team.baseBond || 0),
        team.neighborhood === "off" || team.neighborhood === "deep"
          ? team.neighborhood
          : "standard",
        team.searchOrder === "craft" ? "craft" : "servant",
      ]
    );
    const teamId = info.lastInsertRowid;
    // 「同时保存本次结果」：预设本身照存，结果额外挂一份（没有结果就是普通保存）
    if (team.result !== undefined && team.result !== null) {
      storeResult(teamId, {
        result: team.result,
        request: team.request,
        dataRevision: team.dataRevision,
      });
    }
    return teamId;
  }

  function listUserTeams() {
    const rows = sql.all(
      `SELECT t.id, t.name, t.fixed_servants AS fixedServants, t.fixed_crafts AS fixedCrafts,
              t.support_id AS supportId, t.support_craft_id AS supportCraftId,
              t.support_second_craft_id AS supportSecondCraftId,
              t.support_position AS supportPosition, t.cost_limit AS costLimit, t.strategy,
              t.quality_mode AS qualityMode, t.mode, t.crown_class AS crownClass,
              t.crown_positions AS crownPositions, t.base_bond AS baseBond, t.neighborhood,
              t.search_order AS searchOrder, t.created_at AS createdAt,
              t.result_id AS resultId, r.data_revision AS resultDataRevision,
              r.created_at AS resultSavedAt
         FROM user_teams t LEFT JOIN saved_results r ON r.id = t.result_id
        ORDER BY t.id DESC`
    );
    for (const r of rows) {
      try {
        r.fixedServants = JSON.parse(r.fixedServants || "[]");
      } catch (_) {
        r.fixedServants = [];
      }
      try {
        r.fixedCrafts = JSON.parse(r.fixedCrafts || "[]");
      } catch (_) {
        r.fixedCrafts = [];
      }
      try {
        r.crownPositions = JSON.parse(r.crownPositions || "[]");
      } catch (_) {
        r.crownPositions = [];
      }
      // 列表只带"有没有结果"的摘要，**不取结果正文**（可能几百 KB）
      r.hasResult = !!r.resultId;
    }
    return rows;
  }

  /** 取某预设挂着的那份结果（打开预设时按需加载，不重算）。 */
  function getUserTeamResult(teamId) {
    const row = sql.get(
      `SELECT r.id AS resultId, r.data_revision AS dataRevision, r.request_json AS requestJson,
              r.result_json AS resultJson, r.created_at AS savedAt
         FROM user_teams t JOIN saved_results r ON r.id = t.result_id
        WHERE t.id = ?`,
      [Number(teamId)]
    );
    if (!row) return null;
    const parse = (raw) => {
      if (raw === undefined || raw === null || raw === "") return null;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    };
    return {
      resultId: row.resultId,
      dataRevision: row.dataRevision || null,
      savedAt: row.savedAt || null,
      request: parse(row.requestJson),
      result: parse(row.resultJson),
    };
  }

  function saveUserTeamResult(payload = {}) {
    const out = storeResult(payload.teamId, payload);
    return { ok: true, resultId: out.resultId, savedAt: out.savedAt };
  }

  function deleteUserTeamResult(teamId) {
    const id = Number(teamId);
    const old = sql.get("SELECT result_id AS resultId FROM user_teams WHERE id = ?", [id]);
    if (old && old.resultId) sql.run("DELETE FROM saved_results WHERE id = ?", [Number(old.resultId)]);
    sql.run("UPDATE user_teams SET result_id = NULL WHERE id = ?", [id]);
    return { ok: true };
  }
  function deleteUserTeam(id) {
    const teamId = Number(id);
    // 连挂着的计算结果一起删（否则会留下孤儿结果行）
    const old = sql.get("SELECT result_id AS resultId FROM user_teams WHERE id = ?", [teamId]);
    if (old && old.resultId) sql.run("DELETE FROM saved_results WHERE id = ?", [Number(old.resultId)]);
    const info = sql.run("DELETE FROM user_teams WHERE id = ?", [teamId]);
    return { ok: info.changes > 0, changes: info.changes };
  }

  return { saveUserTeam, listUserTeams, renameUserTeam, deleteUserTeam, getUserTeamResult, saveUserTeamResult, deleteUserTeamResult };
}
