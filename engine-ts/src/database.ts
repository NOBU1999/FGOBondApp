// P2 数据访问：用仓库已有的 sql.js（WASM SQLite）读库，对应 python-engine/engine/database.py 的查询部分
//
// P4a：库字节与 sql.js 都走平台层（`src/platform.ts`），桌面/网页同一份代码。
import { getPlatform } from "./platform.ts";

export async function openDatabaseFromBytes(bytes: Uint8Array): Promise<any> {
  const SQL = await getPlatform().loadSqlJs();
  return new SQL.Database(bytes);
}

/** 打开一个现有的 SQLite 库（只读用途；写库在 databaseWrite.ts）。 */
export async function openDatabase(dbPath: string): Promise<any> {
  return openDatabaseFromBytes(getPlatform().getDbBytes(dbPath));
}

export function allRows(db: any, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const out: any[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

export function getMeta(db: any, key: string): string | null {
  const rows = allRows(db, "SELECT value FROM app_meta WHERE key = ?", [key]);
  return rows.length > 0 ? rows[0]["value"] : null;
}

export function queryServants(db: any): any[] {
  return allRows(db, "SELECT * FROM servants ORDER BY collection_no");
}

export function queryStageTraits(db: any, servantId: number, stage?: string): any[] {
  let sql =
    "SELECT servant_id, stage, trait, trait_id FROM servant_stage_traits WHERE servant_id=?";
  const params: any[] = [servantId];
  if (stage) {
    sql += " AND stage=?";
    params.push(stage);
  }
  sql += " ORDER BY stage, trait";
  return allRows(db, sql, params);
}

export function queryCrafts(db: any, bondOnly = true): any[] {
  let sql = "SELECT * FROM crafts";
  if (bondOnly) sql += " WHERE is_bond_ce = 1";
  sql += " ORDER BY collection_no";
  const out: any[] = [];
  for (const r of allRows(db, sql)) {
    const trigger = r["trigger_traits_json"] ? JSON.parse(r["trigger_traits_json"]) : [];
    out.push({ ...r, trigger_traits: trigger, craft_type: r["is_bond_ce"] ? "bond" : "other" });
  }
  return out;
}
