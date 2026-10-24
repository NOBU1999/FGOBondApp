// 安卓 / 网页入口（Worker，platformWeb）：宿主先注入库字节与 sql.js 加载器，再调 runCalc。
import { getPlatform, type Platform } from "../src/platform.ts";
import { loadContext } from "../src/calculator.ts";
import { parseRequest } from "../src/models.ts";
import { searchTopTeams } from "../src/search.ts";
import { buildPayload, payloadText, makeVerificationTokens } from "../src/verification.ts";
import "../src/platformWeb.ts";

export interface RunCalcArgs {
  dbBytes: Uint8Array;
  request: Record<string, any>;
  createdAt?: string;
  /** 进度回调（桌面/安卓宿主各自决定怎么显示；安卓 Worker 里转发成 postMessage） */
  onProgress?: ((msg: string) => void) | null;
  /**
   * 取消钩子：宿主在**别处**设置标志，这里每查一次就能看到。
   * 安卓点"停止"走它 —— 超级模式体面收尾（`status: "partial"`），普通模式抛「已取消」。
   */
  shouldCancel?: (() => boolean) | null;
  /**
   * 让出事件循环的间隔（毫秒）。因为网页宿主的取消标志是**异步**消息设进来的，
   * 不让出事件循环就永远读不到 ⇒ 停止按钮失效。安卓传 250；不传 = 不让出（与桌面一致）。
   */
  yieldEveryMs?: number;
}

export const platform: Platform = getPlatform();

/** 宿主（boot.js 的 Worker）把库字节交进来后调用；返回与桌面引擎同形状的结果对象。 */
export async function runCalc(args: RunCalcArgs): Promise<Record<string, any>> {
  const p = getPlatform();
  p.registerDbBytes(args.dbBytes);
  const req = parseRequest(args.request);
  // 区服要从**请求**里取：简中服要读 `*_cn` 特性表、并剔掉未实装从者（与桌面完全同口径）
  const ctx = await loadContext("(host-provided)", req.server_region);
  const shouldCancel = args.shouldCancel ?? null;
  const yieldEveryMs = Math.max(0, Number(args.yieldEveryMs ?? 0) || 0);
  const hooks = yieldEveryMs > 0 ? { yieldEveryMs } : null;
  const result = await searchTopTeams(ctx, req, args.onProgress ?? null, shouldCancel, hooks);
  try {
    const tokens = await makeVerificationTokens(ctx, args.request, result, { createdAt: args.createdAt });
    result.verificationToken = tokens.repro;
    result.verificationTokenFull = tokens.full;
  } catch {
    result.verificationToken = "";
    result.verificationTokenFull = "";
  }
  return result;
}

export { buildPayload, payloadText };
