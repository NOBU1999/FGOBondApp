// 桌面宿主入口（worker_threads）：与 Python 引擎的 `--mode calculate|check|update` 一一对应。
// 宿主（main/engine-ts-worker.js）通过 workerData 传 { appRoot, dbPath, mode, payload }，
// 这里把进度按 `[progress] ...` 的形式回传（与 Python 引擎 stderr 的格式逐字一致）。
import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { setAppRoot } from "../src/platformNode.ts";
import { costOverridesOf, loadContext, withServantCostOverrides } from "../src/calculator.ts";
import { parseRequest } from "../src/models.ts";
import { searchTopTeams } from "../src/search.ts";
import { makeVerificationTokens } from "../src/verification.ts";
import { checkUpdate, dataCfg, updateDatabase } from "../src/dataFetch.ts";
import { updateEventBondBonus } from "../src/eventBonus.ts";

interface Job {
  appRoot: string;
  dbPath: string;
  mode: "calculate" | "check" | "update";
  payload?: Record<string, any> | null;
}

const job = workerData as Job;
setAppRoot(job.appRoot);

const post = (msg: any): void => {
  parentPort!.postMessage(msg);
};
const progress = (text: string): void => {
  post({ type: "progress", line: `[progress] ${text}` });
};

async function runCalculate(payload: Record<string, any>): Promise<Record<string, any>> {
  const req = parseRequest(payload);
  // 超级模式：宿主点"停止"时会写这个文件；引擎发现它就**体面收尾**（返回 status="partial"），
  // 而不是被直接杀掉、白算一场。普通档位不接这个开关（保持"杀进程"语义）。
  const stopFile = String(payload.stopFile || "").trim();
  const superOn = Number(payload.superMode || 0) > 1;
  const shouldCancel:
    | (() => boolean)
    | null =
    superOn && stopFile
      ? () => {
          try {
            return fs.existsSync(stopFile);
          } catch {
            return false;
          }
        }
      : null;
  progress("正在加载本地数据...");
  const baseCtx = await loadContext(job.dbPath, req.server_region);
  // 玛修那类"可调 Cost"的请求级覆盖（0/16）——必须作用在整趟搜索与验证串上
  const ctx = withServantCostOverrides(baseCtx, costOverridesOf(req.box));

  if (req.cost_limit < 50 || req.cost_limit > 200) {
    throw new Error("Cost上限需在50~200之间");
  }
  if (req.strategy === "target_max" && req.target_servant_id === null) {
    throw new Error("指定从者最大化策略需要提供 targetServantId");
  }

  progress("正在准备队伍布局...");
  // 桌面不让出事件循环：这里的取消是同步读文件，`pump` 保持空转（与移植前逐字节一致）
  const result = await searchTopTeams(ctx, req, progress, shouldCancel);
  if ((result.top20 ?? []).length === 0 && result.status !== "partial") {
    throw new Error("当前配置下无法组成任何队伍，请提高Cost上限或调整Box/固定配置");
  }

  progress("生成验证串...");
  try {
    const tokens = await makeVerificationTokens(ctx, payload, result);
    result.verificationToken = tokens.repro;
    result.verificationTokenFull = tokens.full;
  } catch {
    // 生成验证串失败不影响正常计算（与 Python 侧一致）
    result.verificationToken = "";
    result.verificationTokenFull = "";
  }
  progress("计算完成");
  return result;
}

async function main(): Promise<void> {
  try {
    let result: Record<string, any>;
    if (job.mode === "check") {
      progress("正在检查远程数据...");
      result = await checkUpdate(null, job.dbPath);
      progress("检查完成");
    } else if (job.mode === "update") {
      progress("正在下载并重建数据...");
      result = await updateDatabase({
        dbPath: job.dbPath,
        useCache: true,
        progress,
        eventBonusUpdater: (o) => updateEventBondBonus(o),
      });
      if (result.status === undefined) result.status = "success";
      progress("数据更新完成");
    } else {
      if (!job.payload) throw new Error("stdin 中没有收到 JSON 输入");
      result = await runCalculate(job.payload);
    }
    post({ type: "result", payload: result });
  } catch (exc: any) {
    post({ type: "error", message: String(exc?.message ?? exc) });
  }
}

void main();
