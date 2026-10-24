// 桌面实现（Electron main / worker_threads / 命令行）：全部走 Node 原生，行为与改造前逐字节一致。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
// ⚠️ 静态 import：桌面 bundle 会把 sql.js 一起打进来 ——
//    打包版的 app.asar 里**没有 node_modules**，动态 require 在发布包中必然找不到。
import { setPlatform, type Platform, type SqlJsOptions } from "./platform.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pendingDbBytes: Uint8Array | null = null;
let SQL_MODULE: any = null;
/** 宿主（worker 入口 / 主进程）可以显式指定应用根：打包后 worker 在 dist 里，靠相对路径找不到 node_modules */
let APP_ROOT: string | null = null;
export function setAppRoot(root: string): void {
  APP_ROOT = root;
}

const toU8 = (b: Buffer | Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export const nodePlatform: Platform = {
  name: "node",

  env(key: string): string | undefined {
    return process.env[key];
  },

  // 桌面：总量给得很宽（实测最大形状 47.7 万套），只为挡住"无上界"的可能
  maxTotalWorkPerRequest: (() => {
    const raw = Number(process.env.FGO_TS_TOTAL_WORK ?? 1500000);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 1500000;
  })(),
  // 桌面：RSS 软上限（堆上限 6GB，留余量）；超了优雅收尾，而不是等 V8 崩
  maxRssMb: (() => {
    const raw = Number(process.env.FGO_TS_MAX_RSS_MB ?? 5500);
    return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5500;
  })(),
  memoryUsage() {
    const m = process.memoryUsage();
    return { heapUsed: m.heapUsed, rss: m.rss };
  },

  readFileBytes(filePath: string): Uint8Array {
    return toU8(fs.readFileSync(filePath));
  },

  registerDbBytes(bytes: Uint8Array | null): void {
    pendingDbBytes = bytes;
  },

  getDbBytes(filePath: string): Uint8Array {
    if (pendingDbBytes) return pendingDbBytes;
    return toU8(fs.readFileSync(filePath));
  },

  utf8Encode: (text) => toU8(Buffer.from(text, "utf8")),
  utf8Decode: (bytes) => Buffer.from(bytes).toString("utf8"),
  b64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
  b64Decode: (text) => toU8(Buffer.from(text, "base64")),
  b64UrlEncode: (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
  b64UrlDecode(text: string): Uint8Array {
    let s = text.trim().replace(/-/g, "+").replace(/_/g, "/");
    s += "=".repeat((4 - (s.length % 4)) % 4);
    return toU8(Buffer.from(s, "base64"));
  },

  async deflate(bytes: Uint8Array, level = 9): Promise<Uint8Array> {
    return toU8(zlib.deflateSync(Buffer.from(bytes), { level }));
  },
  async inflate(bytes: Uint8Array): Promise<Uint8Array> {
    return toU8(zlib.inflateSync(Buffer.from(bytes)));
  },
  async gunzip(bytes: Uint8Array): Promise<Uint8Array> {
    return toU8(zlib.gunzipSync(Buffer.from(bytes)));
  },

  async loadSqlJs(opts: SqlJsOptions = {}): Promise<any> {
    if (SQL_MODULE) return SQL_MODULE;
    const root = opts.appRoot ?? APP_ROOT ?? process.env.FGO_APP_ROOT ?? process.cwd();
    const initSqlJs = loadInitSqlJs(root);
    const wasmPath = findSqlWasm(root);
    // 直接给字节：不依赖 locateFile / cwd / wasm 的 URL 解析
    SQL_MODULE = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    return SQL_MODULE;
  },
};

/**
 * 加载 sql.js 的 JS 部分（**不能静态 import**：发布包里没有 node_modules）。
 * 依次找：<appRoot>/dist/engine-ts/sql-wasm.js → 与 bundle 同目录 → appRoot 的 node_modules。
 */
function loadInitSqlJs(appRoot: string): any {
  const candidates = [
    path.join(appRoot, "dist", "engine-ts", "sql-wasm.js"),
    path.join(HERE, "sql-wasm.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const req = createRequire(p);
      const mod = req(p);
      return mod && mod.default && typeof mod.default === "function" ? mod.default : mod;
    }
  }
  const req = createRequire(path.join(appRoot, "package.json"));
  return req("sql.js");
}

/** 找 sql-wasm.wasm：打包版在 bundle 旁边，源码运行在 node_modules 里 */
function findSqlWasm(appRoot: string): string {
  const candidates = [
    path.join(appRoot, "dist", "engine-ts", "sql-wasm.wasm"), // 打包后（release/MyFGOApp/dist/engine-ts/）
    path.join(HERE, "sql-wasm.wasm"),                          // 与 bundle 同目录运行
    path.join(appRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm"), // 源码运行
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `找不到 sql-wasm.wasm。找过：\n  ${candidates.join("\n  ")}\n` +
      "打包前请运行 npm run build:engine-ts（它会顺带把 wasm 复制到 dist/engine-ts/）",
  );
}

setPlatform(nodePlatform);
