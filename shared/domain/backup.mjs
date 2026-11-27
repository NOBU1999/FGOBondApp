/**
 * backup 领域：个人数据的**导出 / 导入**（v0.3.8 第 9 项：跨端数据迁移）
 *
 * 为什么要它
 * ----------
 * 0.3.8 起个人数据单独放在 `db/fgo_data.db`（+ 安卓的 DATA/fgo_data.db），
 * 换手机 / 换电脑 / 重装系统时把整个文件夹拷过去不一定方便，所以提供一个
 * 「导出成一个 JSON 文件 → 在另一台机器上导入」的通道。
 *
 * 格式（尽量宽松、向前兼容）
 * --------------------------
 * {
 *   "kind": "personal-data",          // 固定值，防止误导入别的 JSON
 *   "formatVersion": 1,
 *   "appVersion": "0.3.8",
 *   "exportedAt": "2026-11-27T...",
 *   "tables": { "accounts": [ {…}, … ], "user_box": [ … ], … },
 *   "meta":   { "active_account_id": "1", "server_region": "cn", … }
 * }
 *
 * 导入时的取舍
 * ------------
 * - **整份替换**（不是合并）：先清空个人表，再写入文件里的内容 —— 行为可预期，
 *   也不会出现"两台机器的 Box 混在一起"这种半吊子状态。
 * - 只认已知表 / 已知设置键；文件里多出来的字段直接忽略（老版本导出的文件也能读）。
 * - 列取交集：文件里缺的列用默认值，多出来的列丢掉。
 * - 解析失败 / 不是本程序的格式 ⇒ 抛错且**一行都不写**。
 */

import { USER_META_KEYS, USER_TABLES } from "../storage/schema.mjs";

/** 当前导出的格式版本（只增不改语义；导入接受 <= 这个值的文件） */
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_KIND = "personal-data";

export function createBackupDomain({ sql }) {
  function tableColumns(table) {
    // 表名只来自 USER_TABLES（固定清单），这里不做转义也不接受外部输入
    try {
      return sql.all(`SELECT name FROM pragma_table_info('${table}')`).map((r) => String(r.name));
    } catch (_) {
      return [];
    }
  }

  function tableExists(table) {
    const row = sql.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    return Boolean(row);
  }

  function readAll(table) {
    if (!tableExists(table)) return [];
    return sql.all(`SELECT * FROM "${table}"`);
  }

  function resetSequence(table) {
    let maxRowId = 0;
    try {
      const row = sql.get(`SELECT COALESCE(MAX(rowid), 0) AS m FROM "${table}"`);
      maxRowId = Number((row && row.m) || 0);
    } catch (_) {
      return;
    }
    try {
      sql.run("DELETE FROM sqlite_sequence WHERE name = ?", [table]);
      sql.run("INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)", [table, maxRowId]);
    } catch (_) {
      // 不是 AUTOINCREMENT 表（或没有 sqlite_sequence）⇒ 不需要修正
    }
  }

  /** 导出：返回 { json, counts, exportedAt } */
  function exportPersonalData(options = {}) {
    const exportedAt = new Date().toISOString();
    const tables = {};
    const counts = {};
    for (const table of USER_TABLES) {
      const rows = readAll(table);
      tables[table] = rows;
      counts[table] = rows.length;
    }
    const meta = {};
    for (const key of USER_META_KEYS) {
      const row = sql.get("SELECT value FROM app_meta WHERE key = ?", [key]);
      if (row && row.value !== undefined && row.value !== null) meta[key] = String(row.value);
    }
    const payload = {
      kind: EXPORT_KIND,
      formatVersion: EXPORT_FORMAT_VERSION,
      appVersion: String(options.appVersion || ""),
      exportedAt,
      tables,
      meta,
    };
    const stamp = exportedAt.slice(0, 10).replace(/-/g, "");
    return {
      kind: EXPORT_KIND,
      formatVersion: EXPORT_FORMAT_VERSION,
      json: JSON.stringify(payload),
      counts,
      exportedAt,
      filename: `FGO牵绊推荐器-个人数据-${stamp}.json`,
    };
  }

  function fail(message) {
    const err = new Error(message);
    err.code = "IMPORT_INVALID";
    throw err;
  }

  /** 解析 + 校验；抛出的错误信息直接给界面看 */
  function parsePayload(text) {
    if (typeof text !== "string" || !text.trim()) fail("文件是空的，或者不是文本格式");
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      fail("这个文件不是有效的 JSON（是不是选错了文件？）");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      fail("文件内容不是本程序导出的个人数据");
    }
    if (data.kind !== EXPORT_KIND) {
      fail("文件内容不是本程序导出的个人数据（缺少标识）");
    }
    const version = Number(data.formatVersion);
    if (!Number.isFinite(version) || version < 1) {
      fail("文件缺少格式版本号，无法识别");
    }
    if (version > EXPORT_FORMAT_VERSION) {
      fail(`这个文件来自更新的版本（格式 v${version}），请先升级程序再导入`);
    }
    if (!data.tables || typeof data.tables !== "object" || Array.isArray(data.tables)) {
      fail("文件里没有个人数据");
    }
    const tables = {};
    let rowTotal = 0;
    for (const table of USER_TABLES) {
      const rows = data.tables[table];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) fail(`「${table}」的内容格式不对`);
      if (rows.length > 200000) fail(`「${table}」的行数异常（${rows.length}），文件可能损坏`);
      const clean = [];
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        clean.push(row);
      }
      tables[table] = clean;
      rowTotal += clean.length;
    }
    if (!Object.keys(tables).length) fail("文件里没有可导入的数据表");
    if (!rowTotal) fail("文件里一条数据都没有（可能是空备份）");
    const meta = {};
    if (data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)) {
      for (const key of USER_META_KEYS) {
        if (data.meta[key] !== undefined && data.meta[key] !== null) meta[key] = String(data.meta[key]);
      }
    }
    return { tables, meta, formatVersion: version, appVersion: String(data.appVersion || "") };
  }

  /**
   * 导入：整份替换个人数据。
   * 调用方（桌面 / 安卓宿主）负责在调用前备份当前个人库。
   */
  function importPersonalData(text) {
    const parsed = parsePayload(text);
    const counts = {};
    sql.tx(() => {
      for (const table of USER_TABLES) {
        if (!tableExists(table)) continue;
        sql.run(`DELETE FROM "${table}"`);
      }
      for (const table of USER_TABLES) {
        const rows = parsed.tables[table];
        if (!rows || !rows.length) {
          counts[table] = 0;
          continue;
        }
        const columns = tableColumns(table);
        if (!columns.length) {
          counts[table] = 0;
          continue;
        }
        let inserted = 0;
        for (const row of rows) {
          const shared = columns.filter((c) => row[c] !== undefined);
          if (!shared.length) continue;
          const placeholders = shared.map(() => "?").join(", ");
          const names = shared.map((c) => `"${c}"`).join(", ");
          sql.run(
            `INSERT INTO "${table}" (${names}) VALUES (${placeholders})`,
            shared.map((c) => row[c])
          );
          inserted += 1;
        }
        counts[table] = inserted;
      }
      for (const table of USER_TABLES) resetSequence(table);
      for (const key of USER_META_KEYS) {
        if (parsed.meta[key] === undefined) continue;
        sql.run("INSERT OR REPLACE INTO main.app_meta(key, value) VALUES (?, ?)", [key, parsed.meta[key]]);
      }
      // 选中的账号必须真实存在，否则界面会落到一个空账号上
      const active = sql.get("SELECT value FROM app_meta WHERE key = 'active_account_id'");
      const activeId = active ? Number(active.value) : 0;
      const exists =
        activeId > 0 ? sql.get("SELECT id FROM accounts WHERE id = ?", [activeId]) : null;
      if (!exists) {
        const first = sql.get("SELECT id FROM accounts ORDER BY id LIMIT 1");
        if (first) sql.run("INSERT OR REPLACE INTO main.app_meta(key, value) VALUES ('active_account_id', ?)", [String(first.id)]);
      }
    });
    return {
      counts,
      formatVersion: parsed.formatVersion,
      appVersion: parsed.appVersion,
      accounts: counts.accounts || 0,
      box: counts.user_box || 0,
    };
  }

  return { exportPersonalData, importPersonalData };
}
