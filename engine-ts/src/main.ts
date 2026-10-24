// P3.5：命令行入口（--mode calculate|check|update）
//
// 用途：宿主（P4）还没接线之前，先用它冒烟 / 手工跑「更新数据」。
// 验证串：生成侧已移植（`src/verification.ts`，TS 一律生成 zlib 变体 `FGOBONDV3Z.`，
// 任何旧解码端都认）。PPMd（`FGOBONDV3.`）与 Fernet（v1/v2）两条**解码**分支不搬 ——
// 应用没有"导入验证串"的入口，历史串由开发侧 `reproduce_verification.py` 解。
// 平台实现必须最先加载（桌面走 Node：fs / zlib / sql.js）
import "./platformNode.ts";
import { loadContext } from "./calculator.ts";
import { parseRequest } from "./models.ts";
import { searchTopTeams } from "./search.ts";
import { checkUpdate, configureDataPaths, dataCfg, updateDatabase } from "./dataFetch.ts";
import { makeVerificationTokens } from "./verification.ts";
import { updateEventBondBonus } from "./eventBonus.ts";

const logProgress = (message: string): void => {
  process.stderr.write(`[progress] ${message}\n`);
};

export interface CliOptions {
  dbPath?: string;
  appRoot?: string;
  rawCacheDir?: string;
  engineDataDir?: string;
  useCache?: boolean;
  /** 关掉网络（测试用） */
  offline?: boolean;
}

function applyConfig(opts: CliOptions): void {
  const over: Record<string, any> = {};
  if (opts.appRoot) over.projectRoot = opts.appRoot;
  if (opts.rawCacheDir) over.rawCacheDir = opts.rawCacheDir;
  if (opts.engineDataDir) over.engineDataDir = opts.engineDataDir;
  if (opts.dbPath) over.dbPath = opts.dbPath;
  if (opts.offline) over.netEnabled = false;
  if (Object.keys(over).length) configureDataPaths(over);
}

export async function calculateFromData(
  data: Record<string, any>,
  opts: CliOptions = {},
): Promise<Record<string, any>> {
  applyConfig(opts);
  const req = parseRequest(data);
  logProgress("正在加载本地数据...");
  const ctx = await loadContext(opts.dbPath ?? dataCfg.dbPath, req.server_region);

  if (req.cost_limit < 50 || req.cost_limit > 200) {
    throw new Error("Cost上限需在50~200之间");
  }
  if (req.strategy === "target_max" && req.target_servant_id === null) {
    throw new Error("指定从者最大化策略需要提供 targetServantId");
  }

  logProgress("正在准备队伍布局...");
  const result = await searchTopTeams(ctx, req, logProgress, null);
  // 超级模式下用户点了"停止"：可能还一支队伍都没评出来 —— 那也是有效结果
  if ((result.top20 ?? []).length === 0 && result.status !== "partial") {
    throw new Error("当前配置下无法组成任何队伍，请提高Cost上限或调整Box/固定配置");
  }

  logProgress("生成验证串...");
  try {
    const tokens = await makeVerificationTokens(ctx, data, result);
    result["verificationToken"] = tokens.repro;
    result["verificationTokenFull"] = tokens.full;
  } catch {
    // 生成验证串失败不应影响正常计算（与 Python 侧一致）
    result["verificationToken"] = "";
    result["verificationTokenFull"] = "";
  }
  logProgress("计算完成");
  return result;
}

export async function runUpdate(opts: CliOptions = {}): Promise<Record<string, any>> {
  applyConfig(opts);
  logProgress("正在下载并重建数据...");
  const result = await updateDatabase({
    dbPath: opts.dbPath ?? dataCfg.dbPath,
    useCache: opts.useCache ?? true,
    progress: logProgress,
    eventBonusUpdater: (o) => updateEventBondBonus(o),
  });
  logProgress("数据更新完成");
  return result;
}

export async function runCheck(opts: CliOptions = {}): Promise<Record<string, any>> {
  applyConfig(opts);
  logProgress("正在检查远程数据...");
  const result = await checkUpdate(null, opts.dbPath ?? dataCfg.dbPath);
  logProgress("检查完成");
  return result;
}

export async function main(argv: string[] = []): Promise<number> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      args.set(k, v ?? argv[++i] ?? "");
    }
  }
  const mode = args.get("mode") ?? "calculate";
  const dbPath = args.get("db") ?? undefined;
  const start = Date.now();
  try {
    let result: Record<string, any>;
    if (mode === "check") {
      result = await runCheck({ dbPath });
    } else if (mode === "update") {
      result = await runUpdate({ dbPath });
    } else {
      const raw = await readStdin();
      if (!raw.trim()) throw new Error("stdin 中没有收到 JSON 输入");
      result = await calculateFromData(JSON.parse(raw), { dbPath });
    }
    if (result["status"] === undefined) result["status"] = "success";
    process.stdout.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (exc: any) {
    process.stdout.write(
      JSON.stringify({
        status: "error",
        message: String(exc?.message ?? exc),
        elapsed: Number(((Date.now() - start) / 1000).toFixed(3)),
      }) + "\n",
    );
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

// 直接 `node main.ts --mode=check` 时跑 CLI
if (process.argv[1] && process.argv[1].endsWith("main.ts")) {
  process.exitCode = await main(process.argv.slice(2));
}
