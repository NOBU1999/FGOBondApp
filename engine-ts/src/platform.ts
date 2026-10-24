// 平台抽象层（P4a）：把"Node 专有 API"收敛到一个接口，让同一份引擎代码能跑在
// 桌面（Electron main / worker_threads）和安卓（WebView Worker）两种宿主里。
//
// 现实约束（决定了接口形状）：
//  · 桌面有同步 fs；WebView Worker 只有异步的文件访问（走宿主桥）⇒ **压缩/解压一律 async**
//    （桌面 内部仍是同步 zlib，只是包一层 Promise；网页用 CompressionStream）。
//  · 计算链路只需要三件事：**读库字节**、**压缩/解压**、**加载 sql.js**。
//    数据管线（更新数据）只在桌面提供，继续直接用 node:fs（安卓本来就不提供更新数据）。
import type { CalculationRequest } from "./models.ts";

export interface SqlJsOptions {
  /** 应用根目录（桌面：用来定位 node_modules/sql.js） */
  appRoot?: string;
  /** 网页侧：wasm 文件的 URL 前缀（由宿主注入） */
  wasmUrl?: string;
}

export interface Platform {
  readonly name: string;

  // ---- 环境 ----
  env(key: string): string | undefined;

  // ---- 读文件（计算链路只读库）----
  readFileBytes(filePath: string): Uint8Array;
  /** 网页侧由宿主注入"库字节从哪来"（Capacitor 读文件是异步的，宿主先取好） */
  registerDbBytes(bytes: Uint8Array | null): void;
  getDbBytes(filePath: string): Uint8Array;

  // ---- 编解码（替代 Buffer）----
  utf8Encode(text: string): Uint8Array;
  utf8Decode(bytes: Uint8Array): string;
  b64Encode(bytes: Uint8Array): string;
  b64Decode(text: string): Uint8Array;
  /** URL 安全 base64（带 padding，与 Python `urlsafe_b64encode` 一致） */
  b64UrlEncode(bytes: Uint8Array): string;
  b64UrlDecode(text: string): Uint8Array;

  // ---- 压缩（**异步**：网页的 CompressionStream 只能流式）----
  deflate(bytes: Uint8Array, level?: number): Promise<Uint8Array>;
  inflate(bytes: Uint8Array): Promise<Uint8Array>;
  gunzip(bytes: Uint8Array): Promise<Uint8Array>;

  // ---- sql.js ----
  loadSqlJs(opts?: SqlJsOptions): Promise<any>;

  /**
   * 每轮最多枚举多少个阵容（内存安全阀；不设 = 不限）。
   *
   * 为什么需要：极端形状（超级×10 + 结果条数 1000 + 359 人 Box）每轮要枚举 37 万个阵容，
   * 桌面实测峰值 RSS 4.86GB —— 桌面可以把堆抬到 6GB，**WebView Worker 抬不了**，
   * 而且那种时候崩的是整个 worker（玩家看到的是"卡死/闪退"）。
   * ⇒ 网页宿主按平台给一个上限，超了就裁剪并在结果里标 `workCapped`、进度里说清楚
   *   （宁可少搜一点并如实告知，也不要崩）。
   */
  readonly maxWorkPerRound?: number;
}

let CURRENT: Platform | null = null;

export function setPlatform(p: Platform): void {
  CURRENT = p;
}

export function getPlatform(): Platform {
  if (CURRENT === null) {
    throw new Error(
      "平台层未初始化：入口文件必须先 import './platformNode.ts'（桌面）或 './platformWeb.ts'（网页/Worker）",
    );
  }
  return CURRENT;
}

export function hasPlatform(): boolean {
  return CURRENT !== null;
}

/** 供各处做"同一份代码两种宿主"的类型别名 */
export type EngineRequest = CalculationRequest;
