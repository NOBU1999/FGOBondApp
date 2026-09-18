/**
 * sql 端口实现：sql.js（WASM 版 SQLite，同步 API）
 *
 * 契约见 shared/storage/sql-port.md —— 桌面端用 better-sqlite3 / node:sqlite，
 * 安卓（WebView）端用这个 sql.js 版本；共用领域层对两者完全无感。
 *
 * 为什么是 sql.js：它的 API 是**同步**的，与我们的端口签名天然契合
 * （Capacitor 的 SQLite 插件是异步 API，会导致整个领域层要改成 async）。
 *
 * 用法：
 *   const SQL = await initSqlJs({ locateFile: (f) => `./vendor/sqljs/${f}` });
 *   const db = new SQL.Database(existingBytes);   // existingBytes: Uint8Array（可省）
 *   const sql = createSqlJsPort(db);
 */

/** 把参数统一成数组（与桌面端口一致：位置参数、undefined → 空数组） */
function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

/** 最近一次 INSERT 的自增主键（与桌面驱动返回的 lastInsertRowid 对应） */
function lastInsertRowid(db) {
  try {
    const res = db.exec("SELECT last_insert_rowid() AS id");
    if (res.length && res[0].values.length) return Number(res[0].values[0][0]);
  } catch (_) {
    /* ignore */
  }
  return 0;
}

export function createSqlJsPort(db) {
  const port = {
    all(sqlText, params = []) {
      const stmt = db.prepare(sqlText);
      try {
        stmt.bind(normalizeParams(params));
        const rows = [];
        while (stmt.step()) {
          // 必须是普通对象副本：与桌面端口行为一致（node:sqlite 行对象不可直接扩散语义差异）
          rows.push({ ...stmt.getAsObject() });
        }
        return rows;
      } finally {
        stmt.free();
      }
    },

    get(sqlText, params = []) {
      const rows = port.all(sqlText, params);
      return rows.length ? rows[0] : undefined;
    },

    run(sqlText, params = []) {
      const stmt = db.prepare(sqlText);
      let changes = 0;
      try {
        stmt.bind(normalizeParams(params));
        stmt.step();
        changes = Number(db.getRowsModified());
      } finally {
        stmt.free();
      }
      // 与桌面端口保持一致的返回形状（普通数字，不是 BigInt）
      return { changes, lastInsertRowid: lastInsertRowid(db) };
    },

    exec(sqlText) {
      db.exec(sqlText);
    },

    tx(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch (_) {
          /* 回滚失败不掩盖原始错误（与桌面端口一致） */
        }
        throw err;
      }
    },
  };
  return port;
}

/** 把当前内存库导出成字节（用于持久化到文件） */
export function exportDatabaseBytes(db) {
  return db.export();
}
