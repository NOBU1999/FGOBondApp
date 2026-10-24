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

  /**
   * 超级模式倍率的**平台上限**（不设 = 不限制）。
   *
   * 手机端不提供 ×10：它的内存放大是 5~8 倍（实测 4.9GB RSS），而 WebView 的堆上限抬不了。
   * 界面已经不再显示 ×10 这一档，这里再兜一道 —— 老请求 / 存档里的 ×10 会被压到上限。
   */
  readonly maxSuperMult?: number;

  /**
   * **整次请求**的总工作量上限（单位：被枚举的阵容数，跨轮次累加）。
   *
   * 为什么还需要它：`maxWorkPerRound` 只裁"每轮"，超级档位会把轮数一起放大 ——
   * 每轮都合规，总量照样能堆到几 GB（实测 super×10 + topN1000 + 359 人 = 47.7 万套）。
   * 有了总量上限，内存上界就能算出来（≈ 处理量 × 1.2KB + 结果集），而不是靠"祈祷计划别太大"。
   *
   * 超限时**不报错**：用现有结果收尾，标 `workCapped`，进度里说明怎么恢复。
   */
  readonly maxTotalWorkPerRequest?: number;

  /**
   * 进程 RSS 的软上限（MB）。超了就**主动优雅收尾**（返回 partial），而不是等 V8 撞堆上限崩掉。
   *
   * 为什么堆上限不够：`resourceLimits.maxOldGenerationSizeMb` 只管 JS 堆，不管 wasm/sql.js/native buffer，
   * 而且崩溃时用户已经等了两分钟、结果全丢。这里宁可少搜一点，也要把已算的结果交出去。
   */
  readonly maxRssMb?: number;

  /** 读进程内存（只有能读的平台提供；读不到就不做 RSS 保护） */
  memoryUsage?(): { heapUsed: number; rss: number };
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
