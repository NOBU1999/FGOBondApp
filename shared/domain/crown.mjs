/**
 * crown 领域：冠位名单（终章柱子战 / 戴冠战用，按账号隔离）
 *
 * 语义（见 文档\活跃\任务-终章柱子战牵绊加成.md §9.4 / §9.6）：
 * - 这是一份**玩家自己维护的 id 列表**，只做三件事：
 *   ① 名单内的从者被放到某个位置时，该位置**默认勾冠位**（右键仍可取消）；
 *   ② 计算时名单内的从者**保送进候选池**（只能替换、不能追加，见坑 34e）；
 *   ③ 一致性提示：勾了但不在 Box 里 ⇒ 界面上标红。
 * - 合法性（七个普通职阶各 1、EX1 一个、EX2 一个，最多 9 人）**只在界面校验**，
 *   引擎与桥接层不硬拦 —— 桥接层只保证"存得住、取得回、按账号隔离"。
 *
 * 表：user_crown_servants(account_id, servant_id)，主键 (account_id, servant_id)
 */

export function createCrownDomain({ sql, accounts }) {
  function getCrownServants(accountId) {
    const id = accounts.resolveAccountId(accountId);
    const rows = sql.all(
      "SELECT servant_id AS servantId FROM user_crown_servants WHERE account_id = ? ORDER BY servant_id",
      [id]
    );
    return { servants: rows.map((r) => Number(r.servantId)), accountId: id };
  }

  function saveCrownServants(servants, accountId) {
    const id = accounts.resolveAccountId(accountId, { forWrite: true });
    const ids = Array.from(
      new Set((servants || []).map((sid) => Number(sid)).filter((sid) => Number.isFinite(sid) && sid > 0))
    );
    sql.tx(() => {
      sql.run("DELETE FROM user_crown_servants WHERE account_id = ?", [id]);
      const insertSql = "INSERT INTO user_crown_servants(account_id, servant_id) VALUES (?, ?)";
      for (const sid of ids) sql.run(insertSql, [id, sid]);
    });
    return getCrownServants(id);
  }

  return { getCrownServants, saveCrownServants };
}
