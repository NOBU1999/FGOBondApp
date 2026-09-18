/**
 * box 领域：玩家 Box（按账号隔离）+ 抓包导入解析
 *
 * 共用层（跨平台）：只通过注入的能力访问数据/解码。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 *
 * 注入依赖：
 *   sql      —— 数据访问端口（见 shared/storage/sql-port.md）
 *   accounts —— 账号解析（resolveAccountId）
 *   codec    —— { decodeBase64ToUtf8(text) }（base64 解码是平台能力：桌面用 Buffer，浏览器用 atob/TextDecoder）
 */

export function createBoxDomain({ sql, accounts, codec }) {
  function getUserBox(accountId) {
    const id = accounts.resolveAccountId(accountId);
    return sql.all(
      "SELECT servant_id AS servantId, stage, is_max_bond AS isMaxBond, bond_switch1 AS bondSwitch1, bond_switch2 AS bondSwitch2, personal_bonus AS personalBonus, aura_bonus AS auraBonus, bond_rank AS bondRank, bond_max_rank AS bondMaxRank FROM user_box WHERE account_id = ?",
      [id]
    );
  }

  function saveUserBox(entries, accountId) {
    const id = accounts.resolveAccountId(accountId, { forWrite: true });
    return sql.tx(() => {
      sql.run("DELETE FROM user_box WHERE account_id = ?", [id]);
      const insertSql =
        "INSERT INTO user_box (account_id, servant_id, stage, is_max_bond, bond_switch1, bond_switch2, personal_bonus, aura_bonus, bond_rank, bond_max_rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      for (const e of entries || []) {
        sql.run(insertSql, [
          id,
          Number(e.servantId),
          e.stage || "fourth",
          e.isMaxBond ? 1 : 0,
          e.bondSwitch1 ? 1 : 0,
          e.bondSwitch2 ? 1 : 0,
          Number(e.personalBonus || 0),
          Number(e.auraBonus || 0),
          Number(e.bondRank || 0),
          Number(e.bondMaxRank || 0),
        ]);
      }
      return { ok: true, count: (entries || []).length, accountId: id };
    });
  }

  function resetUserBox(accountId) {
    return saveUserBox([], accountId);
  }

  function importCaptureContent(content, accountId) {
    const raw = String(content || "").trim();
    let jsonText = raw;
    if (!raw.startsWith("{") && !raw.startsWith("[")) {
      // 抓包文件通常是 base64，末尾可能是 URL 编码的 %3D
      const normalized = raw.replace(/%3D/gi, "").trim();
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      jsonText = codec.decodeBase64ToUtf8(padded);
    }
    const data = JSON.parse(jsonText);
    const replaced = ((data || {}).cache || {}).replaced || {};
    const collection = replaced.userSvtCollection || [];
    const userSvt = replaced.userSvt || [];
    // Chaldea 会同时读取 userSvt 与 userSvtStorage（第二保管室），
    // iOS/Android 的抓包结构一致；只读 userSvt 会漏掉放在保管室中的从者。
    const userSvtStorage = replaced.userSvtStorage || [];
    // userSvtCollection 是图鉴/收集记录，只用来读取已持有从者的羁绊/满绊信息，
    // 绝不作为“是否持有”的依据；否则会把图鉴里有但已不在仓库的从者错误加入。
    const collectionMap = {};
    for (const rec of collection) {
      const sid = Number(rec && rec.svtId);
      if (Number.isFinite(sid)) collectionMap[sid] = rec;
    }
    const servantIds = new Set(sql.all("SELECT id FROM servants").map((r) => r.id));
    const ownedIds = new Set();
    for (const rec of [...userSvt, ...userSvtStorage]) {
      const sid = Number(rec && rec.svtId);
      if (Number.isFinite(sid) && servantIds.has(sid)) ownedIds.add(sid);
    }
    const entries = [];
    for (const sid of ownedIds) {
      const colRec = collectionMap[sid];
      const bondRank = Number((colRec && colRec.friendshipRank) || 0);
      // Chaldea 规则：
      // - 普通从者默认牵绊上限 10；每使用一个“牵绊上限开放”道具，上限 +1
      // - 玛修基础上限特殊（Chaldea 中为 5），同样按 exceedCount 递增
      // 满绊 = 当前 rank 已达到当前最大可达到 rank（10/10、11/11、13/13、15/15…）
      // 而不是简单 >=15；10/10、11/11 这类旧上限满绊不应获得 25% 全队加成。
      const exceedCount = Number((colRec && colRec.friendshipExceedCount) || 0);
      const isMash = Number(sid) === 800100;
      const defaultMaxRank = isMash ? 5 : 10;
      const maxRank = defaultMaxRank + exceedCount;
      const isAtBondLimit = bondRank > 0 && bondRank >= maxRank;
      const hasTeam25Bonus = bondRank >= 15;
      entries.push({
        servantId: sid,
        stage: "fourth",
        isMaxBond: isAtBondLimit ? 1 : 0,
        bondSwitch1: hasTeam25Bonus ? 1 : 0,
        bondSwitch2: 0,
        personalBonus: 0,
        bondRank: bondRank,
        bondMaxRank: maxRank,
      });
    }
    saveUserBox(entries, accountId);
    return {
      servants: entries.length,
      maxBond: entries.filter((e) => e.isMaxBond).length,
    };
  }

  return { getUserBox, saveUserBox, resetUserBox, importCaptureContent };
}
