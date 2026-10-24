// 网页 / WebView Worker 实现：没有 fs、没有 Buffer、没有同步压缩。
// 依赖宿主注入两样东西（见 README 的"平台层"一节）：
//   ① 库字节：`registerDbBytes()`（Capacitor 读文件是异步的，宿主先取好再交给引擎）
//   ② sql.js 的 wasm 地址：`setSqlJsWasmUrl()` 或用 `loadSqlJs({ wasmUrl })`
import { setPlatform, type Platform, type SqlJsOptions } from "./platform.ts";

let pendingDbBytes: Uint8Array | null = null;
let SQL_MODULE: any = null;
let sqlJsWasmUrl: string | null = null;

/** 宿主（boot.js）在启动时调用：告诉引擎 sql.js 的 wasm 在哪 */
export function setSqlJsWasmUrl(url: string): void {
  sqlJsWasmUrl = url;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

function toU8(v: ArrayBuffer | Uint8Array): Uint8Array {
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function zlibStream(bytes: Uint8Array, format: "deflate" | "gzip", mode: "compress" | "decompress"): Promise<Uint8Array> {
  const g = globalThis as any;
  if (mode === "compress") {
    const cs = new g.CompressionStream(format);
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();
    return collect(cs.readable);
  }
  const ds = new g.DecompressionStream(format);
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return collect(ds.readable);
}

function b64ToBinary(text: string): string {
  // atob 只认标准 base64；URL 变体先归一化
  const s = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  return atob(s + "=".repeat((4 - (s.length % 4)) % 4));
}

export const webPlatform: Platform = {
  name: "web",

  env(key: string): string | undefined {
    const g = globalThis as any;
    return g.__FGO_ENV__?.[key];
  },

  readFileBytes(): Uint8Array {
    throw new Error("网页宿主没有文件系统：请由宿主读取库字节并调用 registerDbBytes()");
  },

  registerDbBytes(bytes: Uint8Array | null): void {
    pendingDbBytes = bytes;
  },

  getDbBytes(): Uint8Array {
    if (!pendingDbBytes) {
      throw new Error("网页宿主还没调用 registerDbBytes() 注入库字节");
    }
    return pendingDbBytes;
  },

  utf8Encode: (text) => enc.encode(text),
  utf8Decode: (bytes) => dec.decode(bytes),

  b64Encode(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  b64Decode(text: string): Uint8Array {
    const bin = b64ToBinary(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  b64UrlEncode(bytes: Uint8Array): string {
    return webPlatform.b64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_");
  },
  b64UrlDecode: (text) => webPlatform.b64Decode(text),

  deflate: (bytes, _level = 9) => zlibStream(bytes, "deflate", "compress"),
  inflate: (bytes) => zlibStream(bytes, "deflate", "decompress"),
  gunzip: (bytes) => zlibStream(bytes, "gzip", "decompress"),

  async loadSqlJs(opts: SqlJsOptions = {}): Promise<any> {
    if (SQL_MODULE) return SQL_MODULE;
    const g = globalThis as any;
    // 宿主注入的加载器优先（安卓侧用的是随包的 sql-wasm.js）
    if (typeof g.__FGO_LOAD_SQLJS__ === "function") {
      SQL_MODULE = await g.__FGO_LOAD_SQLJS__({ wasmUrl: opts.wasmUrl ?? sqlJsWasmUrl });
      return SQL_MODULE;
    }
    throw new Error(
      "网页宿主需要注入 sql.js 加载器：globalThis.__FGO_LOAD_SQLJS__ = (opts) => initSqlJs({ locateFile })",
    );
  },
};

setPlatform(webPlatform);
export const __decode = { toU8, collect };
