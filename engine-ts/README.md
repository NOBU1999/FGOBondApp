# engine-ts —— 引擎的 TypeScript 版（与 `python-engine/` 同源同判据）

> ✅ **2026-10-24 起这是默认引擎**（桌面 `main/engine-factory.js` 默认 `ts`，安卓随包 `engine.txt` 写 `ts`）。
> 想退回 Python：`FGO_ENGINE=python`，或在应用根放 `engine-ts/engine.txt` 内容 `python`。
> ⚠️ 灰度收窄仍在：`check` / `update`（联网 + 写库）继续走 Python，`FGO_ENGINE_ALL=1` 才全切；
> **v0.3.0 删掉 Python 侧时这两条一起改**（清单见 `文档\活跃\方案-引擎TS重写.md` §28.3）。

## 结构

```
src/         22 个源文件（求值 / 上界 / 建队 / 池 / 主流程 / 数据管线 / 验证串 / 平台层）
entry/       worker.ts（桌面 worker_threads）、web.ts（安卓 WebView Worker，浏览器目标）
tests/       engine-units.ts —— 11 项零件级断言（9 项对齐 python-engine/tests/engine_units.py，
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
历史串（V1/V2/V3）仍由开发侧 `python-engine/reproduce_verification.py` 解（不进包、不删）。
