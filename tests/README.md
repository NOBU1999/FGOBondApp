# tests/ —— 一致性契约测试

> 全平台化 · 阶段 3 产物。**一份用例，任何平台都能跑。**
> 新平台（网页 / 安卓）把宿主实现好之后，跑通这里就等于证明"行为对齐"。

## 为什么需要它

Windows 版、网页版、安卓版将来是三套宿主代码。如果没有一套共同的用例，
"对齐"只能靠人肉点界面比对 —— 而界面点不全、也记不住。
这套用例把**契约**（谁接受什么参数、返回什么、报什么错）变成可执行的东西。

## 怎么跑

```bash
npm run test:contracts                  # 跑全部（bridge + engine）
npm run test:contracts -- --suite bridge   # 只跑领域层/桥接契约
npm run test:contracts -- --suite engine   # 只跑引擎协议
npm run test:contracts -- --db <库路径>     # 换数据库（默认 db/fgo_data.db）
npm run test:contracts -- --host <模块>     # 换宿主实现（默认 Windows：main/database.js）
npm run test:contracts -- --verbose        # 打印每条用例的实际返回
```

- 前置：需要 `db/fgo_data.db`（静态数据）。缺库时对应套件 **SKIP 并说明原因**，不会假装通过。
- 引擎套件需要 `python`（可用 `PYTHON` 环境变量覆盖解释器路径）。
- 退出码：`0` = 全部通过（含 SKIP）；`1` = 有失败。

## 两个套件

| 套件 | 文件 | 测什么 |
|---|---|---|
| **bridge** | `contracts/bridge-cases.json` | 界面 ↔ 宿主：账号、Box、排除名单、自定义礼装、队伍、设置、静态数据的**领域行为**（含错误文案） |
| **engine** | `contracts/engine-cases.json` | 宿主 ↔ 引擎：请求/结果结构、错误路径、位置集合、Cost 上限、未知字段容忍、同请求结果可复现 |

### 断言写法（bridge）

```json
{ "method": "accounts.createAccount", "args": ["测试甲"],
  "expect": [ { "path": "result.accounts.length", "eq": 2 },
              { "path": "result.accounts[1].name", "eq": "测试甲" } ] }
```

- `path` 支持 `result.x.y[0].z`、`error`、`ok`。
- 断言三种：`eq`（深比较）、`gte`（≥）、`matches`（正则字符串）。
- 变量：`$firstServantId`、`$servantWithTraits`、`$captureJson`（由运行器按当前库解析，避免把具体 id 写死）。

### 断言写法（engine）

- `errorContains`：期望报错且信息里含该片段（**以引擎实际行为为准**，别按猜的写）。
- `statusEq` / `top20LengthGte` / `teamSizeEq` / `positionsSetEq` / `top20CostUsedLte` / `top20MultiplierGt` / `tokenMatches`：结构不变量。
- `sameAsPrevious`：与上一条用例结果一致（用于"未知字段被忽略""可复现"两条）。
  比较时会剔除 `_` 开头的诊断字段与可能带时间戳的验证串。

## 环境适配

- **管道 vs 文件**：生产宿主用管道（stdin/stdout）。某些沙箱 / CI 禁止父子进程管道（`spawn EPERM`），
  运行器会自动切换到**文件描述符模式**（用真实文件当 stdin/stdout/stderr，协议本身不变），并打印提示。
  也可以显式指定：`-- --transport file`。
- **换平台宿主**：写一个模块导出 `createHost({ dbPath })` → `{ name, call(group, fn, args) }`，
  用 `--host ./platforms/web/host.mjs` 指过去，同一套用例即适用于该平台。

## 临时文件

`tests/.tmp/`（库副本、引擎请求/结果文件）—— 已在 `.gitignore` 里，不会进版本库。
bridge 套件每次从 `db/fgo_data.db` 复制一份并**清空个人表**，所以既不含真实个人数据，也可重复。
