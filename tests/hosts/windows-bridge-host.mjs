/**
 * Windows 宿主的「桥接层」适配器
 *
 *   node tests/run-contracts.mjs --suite bridge --host ./tests/hosts/windows-bridge-host.mjs
 *
 * 走的是重构后 main/ipc-handlers.js 真正使用的那一层：
 *   main/database.js（node:sqlite）→ shared/domain → shared/bridge/data-bridge.mjs
 * 与安卓适配器（android-bridge-host.mjs）跑同一批用例 → 两边行为必须一致。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createDataBridge } from "../../shared/bridge/data-bridge.mjs";
import { callBridgeRoute } from "./bridge-call-map.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const database = require(path.join(ROOT, "main", "database.js"));

export async function createHost({ dbPath }) {
  const db = database.open(dbPath);
  database.ensureSchema(db);

  const bridge = createDataBridge({
    domain: database.getDomain(db),
    platform: {
      appRoot: "(contract-host)",
      dbPath,
      version: "0.0.0-test",
      platformName: "windows",
      // 桌面实现：读运行库同目录的 db/event_bond_bonus.json
      getEventBondBonuses: () => database.getEventBondBonuses(dbPath),
    },
  });

  return {
    name: "windows-bridge (main/database.js + shared/bridge)",
    async call(group, fn, args) {
      return callBridgeRoute(bridge, group, fn, args);
    },
  };
}
