/**
 * Node 侧适配器：让一致性契约测试能跑"安卓宿主"这条链路
 *
 *   node tests/run-contracts.mjs --suite bridge --host ./platforms/android/web-host/node-host.mjs
 *
 * 它做的事和 WebView 里完全一样：sql.js 打开真实库 → shared/domain → 同一套契约。
 * 这是"安卓端数据层与 Windows 行为对齐"的验证手段（无需真机）。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createDomain } from "../../../shared/domain/index.mjs";
import { createSqlJsPort } from "./sql-js-port.mjs";

const require = createRequire(import.meta.url);

/** Node 版 base64 解码（与桌面 Windows 宿主逐字节一致） */
const nodeCodec = {
  decodeBase64ToUtf8(text) {
    return Buffer.from(String(text), "base64").toString("utf8");
  },
};

export async function createHost({ dbPath }) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const bytes = new Uint8Array(readFileSync(dbPath));
  const db = new SQL.Database(bytes);
  const sql = createSqlJsPort(db);
  const domain = createDomain({ sql, codec: nodeCodec });

  return {
    name: "android-web (sql.js, node adapter)",
    async call(group, fn, args) {
      const target = domain[group];
      if (!target || typeof target[fn] !== "function") {
        throw new Error(`宿主未实现 ${group}.${fn}`);
      }
      return target[fn](...(args || []));
    },
  };
}
