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
  /**
   * 剥掉 HTTP 报文头，只留正文。
   *
   * 抓包工具导出的文件有两种：
   *   ① 只导出响应体（正文，通常 base64）—— 一直都能导入；
   *   ② 导出完整「响应」，正文前面多一段报文头：
   *      HTTP/1.1 200 OK\r\nServer: Tengine\r\n...\r\n\r\n<base64 正文>
   *      —— 以前会把整段当 base64 解 → 解出乱码 → 报"读不出抓包数据"（2026-10-09 用户/反馈者踩到）。
   * 只认确实以「状态行 / 请求行」开头的文本，避免把正文误伤。
   */
  function stripHttpMessageHead(text) {
    const withStatus = /^\s*HTTP\/\d(?:\.\d)?\s+\d{3}/i.test(text);
    const withRequest = /^\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\//i.test(text);
    if (!withStatus && !withRequest) return text;
    const match = text.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) return text;
    return text.slice(match.index + match[0].length);
  }

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
      // 抓包文件通常是 base64。三件事都要先处理（2026-10-09 实测）：
      //   ① 有些工具（如 Reqable 的「导出响应」）会在正文前带 HTTP 状态行 + 响应头，先剥掉；
      //   ② 有些链路会把正文里的 + / = 做 URL 转义（%2B / %2F / %3D）。以前只处理 %3D，
      //      结果**正文里混进一个 %2B 就让整段 base64 错位**，后面全变乱码、长度也不再是 4 的倍数
      //      —— 这正是"导出响应体也导入失败"的真因。
      //   ③ 有些工具会把 base64 按 76 列折行，先去掉空白再按 4 补齐。
      const body = stripHttpMessageHead(raw);
      const unescaped = body.replace(/%2B/gi, "+").replace(/%2F/gi, "/").replace(/%3D/gi, "=");
      const compact = unescaped.replace(/\s+/g, "").replace(/=+$/, "");
      const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
      jsonText = codec.decodeBase64ToUtf8(padded);
    }
    const data = (() => {
      try {
        return JSON.parse(jsonText);
      } catch (_) {
        throw new Error(
          "这个文件读不出抓包数据，请确认选的是抓包导出的那个文件" +
            "（若导出的是带 HTTP 头的「响应」，可改选「响应体」再试）"
        );
      }
    })();
    const replaced = ((data || {}).cache || {}).replaced || {};
    // 选错文件时必须报错退出，不能继续往下走：
    // 下面会执行 saveUserBox(entries)，空输入等于把用户的 Box 清空（等价于「恢复Box默认」），
    // 安卓放开了文件类型过滤之后更容易选错文件，所以这里必须挡住。
    if (!replaced.userSvt && !replaced.userSvtStorage && !replaced.userSvtCollection) {
      throw new Error("这个文件里没有找到从者数据，请确认选的是抓包导出的那个文件");
    }
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
