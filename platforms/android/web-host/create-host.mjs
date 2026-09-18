/**
 * 安卓 / 网页宿主（领域层）—— 与 Windows 宿主（main/database.js）等价的最小实现
 *
 * 提供一致性契约测试所需的接口：createHost({ dbPath | db }) → { name, call(group, fn, args) }
 * 领域逻辑本身来自 shared/domain（与桌面同一份代码），这里只做"接线"。
 */

import { createDomain } from "../../../shared/domain/index.mjs";
import { createSqlJsPort } from "./sql-js-port.mjs";

/** 浏览器的 base64 解码（对应桌面端的 Buffer.from(text, "base64")） */
export const webCodec = {
  decodeBase64ToUtf8(text) {
    // atob 不接受 URL 安全字符，先归一化（抓包文本里可能出现 - 和 _）
    const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  },
};

/**
 * 用**已经打开的 sql.js 数据库**建宿主。
 * @param {object} options
 * @param {object} options.db  sql.js 的 Database 实例
 * @param {object} [options.codec] base64 解码能力（默认用浏览器版）
 */
export function createWebHost({ db, codec = webCodec }) {
  const sql = createSqlJsPort(db);
  const domain = createDomain({ sql, codec });

  return {
    name: "android-web (sql.js)",
    sql,
    domain,
    async call(group, fn, args) {
      const target = domain[group];
      if (!target || typeof target[fn] !== "function") {
        throw new Error(`宿主未实现 ${group}.${fn}`);
      }
      return target[fn](...(args || []));
    },
  };
}
