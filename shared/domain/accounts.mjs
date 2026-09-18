/**
 * accounts 领域：多账号（一个账号 = 一套 Box + 一套排除名单）+ 旧版单账号数据迁移
 *
 * 共用层（跨平台）：只通过注入的 sql / meta 端口访问数据。
 * 逻辑与 v0.1.10 的 main/database.js 逐行等价（阶段 1 只搬家、不改行为）。
 */

export const DEFAULT_ACCOUNT_NAME = "默认账号";

export const USER_BOX_COLUMNS = [
  "servant_id",
  "stage",
  "is_max_bond",
  "bond_switch1",
  "bond_switch2",
  "personal_bonus",
  "aura_bonus",
  "bond_rank",
  "bond_max_rank",
];

export function createAccountsDomain({ sql, meta }) {
  function tableColumns(table) {
    try {
      return sql
        .all("SELECT name FROM pragma_table_info(?)", [table])
        .map((r) => String(r.name));
    } catch (_) {
      return [];
    }
  }

  function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  /**
   * 建 accounts 表，并把旧版单账号数据迁移到账号 1。
   * 幂等：已有 account_id 列时只做常量级检查。
   */
  function ensureAccountSchema() {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        note TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // 先把默认账号建好，供旧数据挂靠（account_id=1）
    sql.run(
      "INSERT INTO accounts (id, name) SELECT 1, ? WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id = 1)",
      [DEFAULT_ACCOUNT_NAME]
    );

    migrateUserBoxAccounts();
    migrateUserExclusionsAccounts();

    // active_account_id 指向已删除账号时，回落到第一个账号
    const active = Number(meta.getMetaValue("active_account_id"));
    const hit = sql.get("SELECT id FROM accounts WHERE id = ?", [active || 0]);
    if (!hit) {
      const first = sql.get("SELECT id FROM accounts ORDER BY id LIMIT 1");
      if (first) meta.setMetaValue("active_account_id", first.id);
    }
  }

  function migrateUserBoxAccounts() {
    const existing = tableColumns("user_box");
    if (!existing.length || existing.includes("account_id")) return;
    const shared = USER_BOX_COLUMNS.filter((c) => existing.includes(c));
    if (!shared.includes("servant_id")) return;
    const cols = shared.map(quoteIdent).join(", ");
    sql.tx(() => {
      sql.exec(`
        CREATE TABLE user_box_account_mig (
          account_id INTEGER NOT NULL DEFAULT 1,
          servant_id INTEGER NOT NULL,
          stage TEXT DEFAULT 'fourth',
          is_max_bond INTEGER DEFAULT 0,
          bond_switch1 INTEGER DEFAULT 1,
          bond_switch2 INTEGER DEFAULT 0,
          personal_bonus REAL DEFAULT 0,
          aura_bonus REAL DEFAULT 0,
          bond_rank INTEGER DEFAULT 0,
          bond_max_rank INTEGER DEFAULT 0,
          PRIMARY KEY (account_id, servant_id)
        );
      `);
      sql.exec(
        `INSERT INTO user_box_account_mig (account_id, ${cols}) SELECT 1, ${cols} FROM user_box`
      );
      sql.exec("DROP TABLE user_box");
      sql.exec("ALTER TABLE user_box_account_mig RENAME TO user_box");
    });
  }

  function migrateUserExclusionsAccounts() {
    const existing = tableColumns("user_exclusions");
    if (!existing.length || existing.includes("account_id")) return;
    sql.tx(() => {
      sql.exec(`
        CREATE TABLE user_exclusions_account_mig (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL DEFAULT 1,
          target_type TEXT NOT NULL,
          target_id INTEGER NOT NULL,
          UNIQUE(account_id, target_type, target_id)
        );
      `);
      sql.exec(
        `INSERT INTO user_exclusions_account_mig (id, account_id, target_type, target_id)
         SELECT id, 1, target_type, target_id FROM user_exclusions`
      );
      sql.exec("DROP TABLE user_exclusions");
      sql.exec("ALTER TABLE user_exclusions_account_mig RENAME TO user_exclusions");
    });
  }

  /**
   * 解析账号 id。
   * - 读取（forWrite=false）：显式传入优先；非法/已删除则回落到当前激活账号。
   * - 写入（forWrite=true）：显式传入但账号不存在时直接报错，
   *   避免前端拿着过期 id 把数据写进别的账号。
   */
  function resolveAccountId(accountId, options = {}) {
    const wanted = Number(accountId);
    if (Number.isFinite(wanted) && wanted > 0) {
      const hit = sql.get("SELECT id FROM accounts WHERE id = ?", [wanted]);
      if (hit) return Number(hit.id);
      if (options.forWrite) throw new Error("账号不存在或已被删除，请重新选择账号");
    }
    return getActiveAccountId();
  }

  function getActiveAccountId() {
    const active = Number(meta.getMetaValue("active_account_id"));
    const hit = sql.get("SELECT id FROM accounts WHERE id = ?", [active || 0]);
    if (hit) return Number(hit.id);
    const first = sql.get("SELECT id FROM accounts ORDER BY id LIMIT 1");
    if (first) {
      meta.setMetaValue("active_account_id", first.id);
      return Number(first.id);
    }
    const info = sql.run("INSERT INTO accounts (name, note) VALUES (?, ?)", [
      DEFAULT_ACCOUNT_NAME,
      "",
    ]);
    meta.setMetaValue("active_account_id", info.lastInsertRowid);
    return Number(info.lastInsertRowid);
  }

  function getActiveAccount() {
    const id = getActiveAccountId();
    const row = sql.get("SELECT id, name FROM accounts WHERE id = ?", [id]);
    return row ? { id: Number(row.id), name: row.name } : { id, name: DEFAULT_ACCOUNT_NAME };
  }

  function listAccounts() {
    const accounts = sql
      .all(
        `SELECT a.id, a.name, a.note, a.created_at AS createdAt,
                (SELECT COUNT(*) FROM user_box b WHERE b.account_id = a.id) AS servantCount,
                (SELECT COUNT(*) FROM user_exclusions e WHERE e.account_id = a.id) AS exclusionCount
         FROM accounts a
         ORDER BY a.id`
      )
      .map((r) => ({
        id: Number(r.id),
        name: r.name,
        note: r.note || "",
        createdAt: r.createdAt,
        servantCount: Number(r.servantCount || 0),
        exclusionCount: Number(r.exclusionCount || 0),
      }));
    const activeId = getActiveAccountId();
    return { accounts, activeId };
  }

  function normalizeAccountName(name, fallback) {
    const clean = String(name == null ? "" : name).trim().slice(0, 40);
    return clean || fallback;
  }

  function copyAccountData(fromId, toId) {
    const from = Number(fromId);
    const to = Number(toId);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
    const cols = USER_BOX_COLUMNS.map(quoteIdent).join(", ");
    sql.tx(() => {
      sql.run(
        `INSERT OR REPLACE INTO user_box (account_id, ${cols})
         SELECT ?, ${cols} FROM user_box WHERE account_id = ?`,
        [to, from]
      );
      sql.run(
        `INSERT OR IGNORE INTO user_exclusions (account_id, target_type, target_id)
         SELECT ?, target_type, target_id FROM user_exclusions WHERE account_id = ?`,
        [to, from]
      );
    });
  }

  function createAccount(name, options = {}) {
    const existing = sql.all("SELECT name FROM accounts").map((r) => r.name);
    let candidate = normalizeAccountName(name, "");
    if (!candidate) {
      let n = existing.length + 1;
      while (existing.includes(`账号 ${n}`)) n += 1;
      candidate = `账号 ${n}`;
    }
    const info = sql.run("INSERT INTO accounts (name, note) VALUES (?, ?)", [candidate, ""]);
    const id = Number(info.lastInsertRowid);
    const copyFrom = Number(options && options.copyFromId);
    if (Number.isFinite(copyFrom) && copyFrom > 0 && copyFrom !== id) {
      copyAccountData(copyFrom, id);
    }
    return { id, ...listAccounts() };
  }

  function renameAccount(id, name) {
    const target = Number(id);
    const clean = normalizeAccountName(name, "");
    if (!clean) throw new Error("账号名称不能为空");
    const info = sql.run("UPDATE accounts SET name = ? WHERE id = ?", [clean, target]);
    if (!info.changes) throw new Error("账号不存在");
    return listAccounts();
  }

  function duplicateAccount(id, name) {
    const source = Number(id);
    const hit = sql.get("SELECT id, name FROM accounts WHERE id = ?", [source]);
    if (!hit) throw new Error("账号不存在");
    const fallback = `${hit.name} 副本`;
    return createAccount(name || fallback, { copyFromId: source });
  }

  function deleteAccount(id) {
    const target = Number(id);
    const total = sql.get("SELECT COUNT(*) AS c FROM accounts");
    if (!total || Number(total.c) <= 1) throw new Error("至少保留一个账号");
    const hit = sql.get("SELECT id FROM accounts WHERE id = ?", [target]);
    if (!hit) throw new Error("账号不存在");
    sql.tx(() => {
      sql.run("DELETE FROM user_box WHERE account_id = ?", [target]);
      sql.run("DELETE FROM user_exclusions WHERE account_id = ?", [target]);
      sql.run("DELETE FROM accounts WHERE id = ?", [target]);
    });
    const active = getActiveAccountId();
    meta.setMetaValue("active_account_id", active);
    return listAccounts();
  }

  function setActiveAccount(id) {
    const target = Number(id);
    const hit = sql.get("SELECT id FROM accounts WHERE id = ?", [target]);
    if (!hit) throw new Error("账号不存在");
    meta.setMetaValue("active_account_id", target);
    return listAccounts();
  }

  return {
    ensureAccountSchema,
    migrateUserBoxAccounts,
    migrateUserExclusionsAccounts,
    resolveAccountId,
    getActiveAccountId,
    getActiveAccount,
    listAccounts,
    normalizeAccountName,
    copyAccountData,
    createAccount,
    renameAccount,
    duplicateAccount,
    deleteAccount,
    setActiveAccount,
  };
}
