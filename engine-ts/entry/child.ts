// 桌面宿主入口（独立子进程）：与 worker.ts 同一套引擎核心，只是换了个外壳。
//
// 为什么要有它（v0.3.8 第 2 项）：引擎在 worker_threads 里时与主进程共享同一个 V8 堆上限/进程，
// 极端规模下 OOM 会连界面一起带走。把它放到独立进程后，引擎崩了主界面还在，用户能重试。
//
// 协议（父进程 = main/engine-child.js）：
//   父 → 子  { type: "job", job: { appRoot, dbPath, mode, payload } }
//   子 → 父  { type: "ready" }
//            { type: "progress", line }
//            { type: "result", payload }
//            { type: "error", message }
// 一次计算一个进程：回完 result/error 就退出（内存彻底归还）。
import fs from "node:fs";
import { setAppRoot } from "../src/platformNode.ts";
import { costOverridesOf, loadContext, withServantCostOverrides } from "../src/calculator.ts";
import { parseRequest } from "../src/models.ts";
import { searchTopTeams } from "../src/search.ts";
import { makeVerificationTokens } from "../src/verification.ts";
import { checkUpdate, updateDatabase } from "../src/dataFetch.ts";
import { updateEventBondBonus } from "../src/eventBonus.ts";

interface Job {
  appRoot: string;
  dbPath: string;
  mode: "calculate" | "check" | "update";
  payload?: Record<string, any> | null;
}

const send = (msg: any): void => {
  try {
    process.send?.(msg);
  } catch {
    /* 父进程没了就安静退出 */
  }
};
const progress = (text: string): void => {
  send({ type: "progress", line: `[progress] ${text}` });
};

async function runCalculate(job: Job, payload: Record<string, any>): Promise<Record<string, any>> {
  const req = parseRequest(payload);
  const stopFile = String(payload.stopFile || "").trim();
  const superOn = Number(payload.superMode || 0) > 1;
  const shouldCancel: (() => boolean) | null =
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
  const baseCtx = await loadContext(job.dbPath, req.server_region, req.mode === "pillar", progress);
  const ctx = withServantCostOverrides(baseCtx, costOverridesOf(req.box));

  if (req.cost_limit < 50 || req.cost_limit > 200) {
    throw new Error("Cost上限需在50~200之间");
  }
  if (req.strategy === "target_max" && req.target_servant_id === null) {
    throw new Error("指定从者最大化策略需要提供 targetServantId");
  }

  progress("正在准备队伍布局...");
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
    result.verificationToken = "";
    result.verificationTokenFull = "";
  }
  progress("计算完成");
  return result;
}

async function runJob(job: Job): Promise<Record<string, any>> {
  setAppRoot(job.appRoot);
  if (job.mode === "check") {
    progress("正在检查远程数据...");
    const result = await checkUpdate(null, job.dbPath);
    progress("检查完成");
    return result as Record<string, any>;
  }
  if (job.mode === "update") {
    progress("正在下载并重建数据...");
    const result = await updateDatabase({
      dbPath: job.dbPath,
      useCache: true,
      progress,
      eventBonusUpdater: (o) => updateEventBondBonus(o),
    });
    if (result.status === undefined) result.status = "success";
    progress("数据更新完成");
    return result;
  }
  if (!job.payload) throw new Error("没有收到计算输入");
  return runCalculate(job, job.payload);
}

process.on("message", (msg: any) => {
  if (!msg || msg.type !== "job" || !msg.job) return;
  void (async () => {
    try {
      const result = await runJob(msg.job as Job);
      send({ type: "result", payload: result });
      process.exit(0);
    } catch (exc: any) {
      send({ type: "error", message: String(exc?.message ?? exc) });
      process.exit(1);
    }
  })();
});

send({ type: "ready" });
