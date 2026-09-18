/**
 * exclusions 领域：排除名单（从者 / 礼装，按账号隔离）
 *
 * 共用层（跨平台）：只通过注入的 sql / accounts 访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export function createExclusionsDomain({ sql, accounts }) {
  function getExclusions(accountId) {
    const id = accounts.resolveAccountId(accountId);
    const rows = sql.all(
      "SELECT target_type AS targetType, target_id AS targetId FROM user_exclusions WHERE account_id = ?",
      [id]
    );
    return {
      servants: rows.filter((r) => r.targetType === "servant").map((r) => Number(r.targetId)),
      crafts: rows.filter((r) => r.targetType === "craft").map((r) => Number(r.targetId)),
      accountId: id,
    };
  }

  function saveExclusions(exclusions, accountId) {
    const id = accounts.resolveAccountId(accountId, { forWrite: true });
    sql.tx(() => {
      sql.run("DELETE FROM user_exclusions WHERE account_id = ?", [id]);
      const insertSql =
        "INSERT INTO user_exclusions(account_id, target_type, target_id) VALUES (?, ?, ?)";
      for (const sid of exclusions.servants || []) {
        sql.run(insertSql, [id, "servant", Number(sid)]);
      }
      for (const cid of exclusions.crafts || []) {
        sql.run(insertSql, [id, "craft", Number(cid)]);
      }
    });
    return getExclusions(id);
  }

  return { getExclusions, saveExclusions };
}
