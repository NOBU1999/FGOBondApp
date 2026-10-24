# engine-ts —— 引擎本体（唯一的实现）

> ✅ **这是唯一的引擎**（v0.3.0 起默认；v0.3.1 起仓库里已经没有 Python 侧了）。
> 桌面跑 `entry/worker.ts`（`worker_threads`），安卓跑 `entry/web.ts`（WebView 里的经典 Worker）；
> 计算 / `check` / `update` / 验证串**全部**在这里。
> 想当"老行为基线"对拍：Python 实现已从仓库移除，只在开发侧本地归档（含 `engine.exe` 与解串脚本），**不再维护**。

## 结构

```
src/         22 个源文件（求值 / 上界 / 建队 / 池 / 主流程 / 数据管线 / 验证串 / 平台层）
entry/       worker.ts（桌面 worker_threads）、web.ts（安卓 WebView Worker，浏览器目标）
tests/       engine-units.ts —— 11 项零件级断言（9 项对齐旧实现，
             另 2 项是本侧特有的上界性质：礼装项 ≥ 整数最优、便宜界 ≥ 精确界）
```

## 平台层（关键）

`src/platform.ts` 定义接口，两份实现：

| 能力 | `platformNode.ts` | `platformWeb.ts` |
|---|---|---|
| 读库字节 | `fs.readFileSync` | 宿主 `registerDbBytes()` 注入 |
| 编解码 | `Buffer` | `TextEncoder` / `atob` / `btoa` |
| 压缩 | `zlib` | `CompressionStream` |
| sql.js | `createRequire(<appRoot>/package.json)` | 宿主注入 `globalThis.__FGO_LOAD_SQLJS__` |

**入口必须先 import 平台实现**（`entry/worker.ts` 引 `platformNode`，`entry/web.ts` 引 `platformWeb`），
否则 `getPlatform()` 会抛"平台层未初始化"。

## 打包

```powershell
node scripts/build-engine-ts.mjs          # → dist/engine-ts/worker.mjs（桌面，external sql.js）
node scripts/build-engine-ts.mjs --web    # → dist/engine-ts/web.mjs（安卓/网页，browser 目标）
```

## 断言

```powershell
node engine-ts/tests/engine-units.ts            # 11 项，约 44 秒
node engine-ts/tests/engine-units.ts --list
node engine-ts/tests/engine-units.ts --only=dp
```

## 验证串

只生成、不解码 PPMd/Fernet：TS 一律生成 `FGOBONDV3Z.`（zlib + Base64URL），
`verification.decrypt_token` 先判该前缀 ⇒ 任何旧解码端都能读。
历史串（V1/V2/V3）的解码实现**不随仓库发布**（只在开发侧本地保留，由维护者代跑）。
