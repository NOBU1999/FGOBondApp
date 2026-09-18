/**
 * teams 领域：用户保存的队伍预设（全局，不按账号隔离）
 *
 * 共用层（跨平台）：只通过注入的 sql 端口访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export function createTeamsDomain({ sql }) {
  function saveUserTeam(team) {
    const supportCraftId =
      team.supportCraftId !== undefined && team.supportCraftId !== null ? team.supportCraftId : null;
    const supportSecondCraftId =
      team.supportSecondCraftId !== undefined && team.supportSecondCraftId !== null
        ? team.supportSecondCraftId
        : null;
    const info = sql.run(
      `INSERT INTO user_teams (name, fixed_servants, fixed_crafts, support_id, support_craft_id, support_second_craft_id, support_position, cost_limit, strategy, quality_mode, mode, crown_class, crown_positions, base_bond)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );
    return info.lastInsertRowid;
  }

  function listUserTeams() {
    const rows = sql.all(
      "SELECT id, name, fixed_servants AS fixedServants, fixed_crafts AS fixedCrafts, support_id AS supportId, support_craft_id AS supportCraftId, support_second_craft_id AS supportSecondCraftId, support_position AS supportPosition, cost_limit AS costLimit, strategy, quality_mode AS qualityMode, mode, crown_class AS crownClass, crown_positions AS crownPositions, base_bond AS baseBond, created_at AS createdAt FROM user_teams ORDER BY id DESC"
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
    }
    return rows;
  }

  function deleteUserTeam(id) {
    const info = sql.run("DELETE FROM user_teams WHERE id = ?", [Number(id)]);
    return { ok: info.changes > 0, changes: info.changes };
  }

  return { saveUserTeam, listUserTeams, deleteUserTeam };
}
