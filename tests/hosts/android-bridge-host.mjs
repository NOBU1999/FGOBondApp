/**
 * 安卓宿主的「桥接层」适配器（电脑上跑，不需要真机）
 *
 *   node tests/run-contracts.mjs --suite bridge --host ./tests/hosts/android-bridge-host.mjs
 *
 * 走的是安卓端真正使用的那条链路：
 *   sql.js（WASM SQLite）→ shared/domain → shared/bridge/data-bridge.mjs
 * 与桌面适配器（windows-bridge-host.mjs）跑同一批用例 → 两边行为必须一致。
 * 这能挡住"安卓端某个方法漏了实现 / 行为分叉"这类问题（活动牵绊表就栽过）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDataBridge } from "../../shared/bridge/data-bridge.mjs";
import { createDomain } from "../../shared/domain/index.mjs";
import { createSqlJsPort } from "../../platforms/android/web-host/sql-js-port.mjs";
import { callBridgeRoute } from "./bridge-call-map.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Node 版 base64 解码（与安卓/桌面宿主逐字节一致） */
const nodeCodec = {
  decodeBase64ToUtf8(text) {
    return Buffer.from(String(text), "base64").toString("utf8");
  },
};

export async function createHost({ dbPath }) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));
  const domain = createDomain({ sql: createSqlJsPort(db), codec: nodeCodec });
  // 与桌面一致：首次运行要保证账号表存在（内含旧数据迁移逻辑）
  domain.accounts.ensureAccountSchema();

  const bridge = createDataBridge({
    domain,
    platform: {
      appRoot: "(android)",
      dbPath: "fgo_data.db",
      version: "0.0.0-test",
      platformName: "android",
      // 安卓实现：活动牵绊表随包发布，从 www 根目录取（这里读运行库同目录的那份，与随包一致）
      getEventBondBonuses: () => {
        try {
          const data = JSON.parse(
            readFileSync(path.join(path.dirname(dbPath), "event_bond_bonus.json"), "utf8")
          );
          if (Array.isArray(data)) return data;
          if (data && Array.isArray(data.events)) return data.events;
          return [];
        } catch (_) {
          return [];
        }
      },
    },
  });

  return {
    name: "android-web-bridge (sql.js + shared/bridge)",
    async call(group, fn, args) {
      return callBridgeRoute(bridge, group, fn, args);
    },
  };
}
