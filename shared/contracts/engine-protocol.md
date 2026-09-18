# 宿主 ↔ 计算引擎 协议（v0 初稿）

> 阶段 0 产物。事实来源：`python-engine/engine/main.py`（引擎侧）、`main/python-process.js`（宿主侧）。
> 目标：**任何平台用同一份请求 JSON、同一份结果 JSON** ——
> 桌面（Electron + 子进程）与网页 / 安卓（Worker + WASM）只是"传输方式"不同，协议不变。
> 阶段 3 会把本文件固化成带版本号的正式契约 + 一致性测试夹具。

## 1. 传输形态

### 1.1 桌面（现状，已实现）

```
engine.exe --mode calculate --db <数据库绝对路径>
  stdin :  一个 JSON 对象（请求），写完立即关闭
  stdout:  有且只有一个 JSON 对象（结果）——引擎不许往 stdout 写别的
  stderr:  进度与日志，逐行；进度行惯例前缀 "[progress] "
  退出码:  0 = 成功；1 = 失败（失败时 stdout 仍有 {"status":"error", ...}）
```

宿主读取规则（`python-process.js` 现状）：stdout 全量缓存 → 取**最后一个能解析成 JSON 的行**；
stderr 逐行 → 作为进度事件转发给界面（保留最后 8KB 供报错用）。

### 1.2 浏览器 / 安卓（阶段 4 目标）

```
Worker 内嵌 WASM 引擎
  主线程 → Worker:  postMessage({ type: "request", payload: <同一份请求 JSON> })
  Worker → 主线程:  { type: "progress", message: "..." }        // 逐条
                    { type: "result",   payload: <同一份结果 JSON> }
                    { type: "error",    message: "..." }
```

要求：**请求 / 结果的字段与语义与桌面完全一致**；差异只在"怎么送"。

## 2. 模式

| 模式 | 参数 | 输入 | 用途 | 平台适用 |
|---|---|---|---|---|
| `calculate` | `--mode calculate --db <path>` | stdin JSON | 算队伍 | 全平台 |
| `update` | `--mode update --db <path> [--force-update]` | 无 | 联网更新游戏数据 | **仅桌面**（网页 / 安卓随包发版） |

## 3. 请求结构（`calculate`）

JSON 键名为 **camelCase**（`models.parse_request` 负责转换），字段与默认值：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `box` | `BoxServant[]` | `[]` | 玩家 Box：`{servantId, stage, maxBond, personalBonus, auraBonus, name, servantClass, cost, rarity, traits}` |
| `fixedServants` | `FixedServant[]` | `[]` | 锁定上场的从者：`{servantId, position?, stage?}`（`position` 空 = 自动排位） |
| `fixedCrafts` | `FixedCraft[]` | `[]` | 锁定礼装：`{position, craftId, type?, slot?}`（`slot` 1 = 冠位第二礼装位） |
| `support` | `SupportConfig \| null` | `null` | 助战：`{servantId?, craftId?, position?, secondCraftId?}`；空对象 = 全自动 |
| `costLimit` | `int` | `114` | Cost 上限（引擎校验 50–200） |
| `strategy` | `string` | 总牵绊最大化 | 另有「指定从者最大化」策略（需 `targetServantId`） |
| `excludedServantIds` | `int[]` | `[]` | 排除的从者 |
| `excludedCraftIds` | `int[]` | `[]` | 排除的礼装 |
| `supportExcludedCraftIds` | `int[]` | `[]` | 助战排除的礼装 |
| `serverRegion` | `"jp" \| "cn"` | `"jp"` | 数据区服 |
| `activityBonus` | `float` | `0` | 活动加成 |
| `teaBonus` | `float` | `1` | 午茶 / 助战加成档位 |
| `mode` | `"normal" \| "crown"` | `"normal"` | 冠位模式 |
| `classGroup` | `string`（别名 `classFilter`） | `null` | 限定职阶组；`all` / 空 = 不限 |
| `crownPositions` | `string[]` | `[]` | 启用冠位第二礼装位的位置 |
| `baseBond` | `float` | `0` | 基础牵绊值 |
| `candidatePoolSize` | `int` | `30` | 候选从者池大小 |
| `craftPoolSize` | `int` | `10` | 候选礼装池大小 |
| `topN` | `int` | `20` | 返回前几名 |
| `timeoutMs` | `int` | `10000` | 计算时限（**墙钟**，会影响结果条数 / 名次稳定性） |
| `targetServantId` | `int \| null` | `null` | 指定从者最大化策略必填 |

> 说明：请求里所有"个人数值"（`personalBonus` / `auraBonus` / `traits` 等）由界面侧的 Box 携带，
> 引擎不读玩家的个人数据 → 这也是"验证串能复现"的基础（复现模式把 Box 快照塞进验证串）。

## 4. 结果结构

顶层（成功）：

| 键 | 说明 |
|---|---|
| `status` | `"success"` |
| `topN`（如 `top20`） | `TeamSolution[]`，按分数降序 |
| `verificationToken` | 复现模式验证串（`FGOBONDV3.` 开头，PPMd + Base64URL） |
| `verificationTokenFull` | 完整模式验证串（含全部游戏数据，体积约为复现模式的 1.5 倍） |

`TeamSolution`：`{rank, totalMultiplier, costUsed, baseBond, totalBondPoints, team[], maxBondStats, traitCoverage}`
`TeamMember`：`{position, servantId, name, stage, isSupport, isFixed, isMaxBond, isCrown, craftId, craftName, craftType, secondCraftId, secondCraftName, secondCraftType, bonusDetail}`

失败：`{"status": "error", "message": "...", "elapsed": 秒}`（宿主把它转成异常抛给界面）

内部诊断字段以 `_` 开头（`_elapsed` / `_processed` / `_verifyPhase` 等）：**界面不许依赖**，随时可能变。

## 5. 引擎侧铁律（保证能搬到别的平台）

1. **只用 Python 标准库**；第三方库必须有 `try/except` 降级（现状：`pyppmd`、`cryptography` 仅用于验证串，缺失时降级为"不产验证串"，不影响计算）。
2. **不读固定路径**：数据库位置一律由 `--db` 传入（将来是浏览器虚拟文件系统里的路径）。
3. **不写 stdout 日志**：stdout 只留给那一个结果 JSON；进度一律走 stderr。
4. **不调系统命令、不开网络**（`data_fetcher.py` 是唯一例外，且属平台专属能力，阶段 1 挪出核心）。
5. **结果必须可 JSON 序列化**（不许出现 numpy 类型、Path、set 等）。

## 6. 待办（阶段 3 固化 / 阶段 4 验证）

- [ ] 加 `protocolVersion`，引擎与宿主各自校验，版本不匹配直接报错
- [ ] 每个字段的取值约束与错误文案表（现在散在 `models.py` / `calculator.py` 里）
- [ ] 固定测试用例：同一请求 → 结果快照，三平台共用（放 `tests/`）
- [ ] 明确"墙钟超时"的语义：`timeoutMs` 到点即返回已找到的解，还是必须凑满 `topN`
- [ ] WASM 可行性实测：`sqlite3`（浏览器虚拟 FS）+ 数据落盘的启动耗时与内存占用
