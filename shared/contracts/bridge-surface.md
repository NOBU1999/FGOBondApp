# 桥接接口清单（界面 ↔ 宿主）

> 阶段 0 产物（初稿）。阶段 3 会补上**契约版本号**、参数校验规则、错误约定与一致性测试夹具。
> 事实来源：`preload.js`（当前唯一实现 = Electron 版）。
> 界面调用的 33 个方法 = `renderer/app.js` 实测（另外 3 个定义了但界面没用）。

## 1. 铁律

界面（`renderer/`，将来是 `shared/ui/`）**只能**通过 `window.fgo.<方法>` 与宿主说话：

- 不许 `require`、不许 `ipcRenderer`、不许直接读文件 / 起进程 / 弹系统菜单
- 违规由 `npm run check:platform` 拦下（扫 `shared/`、`renderer/`、`python-engine/engine/`）

**归属**三类：

| 标记 | 含义 | 阶段 1 怎么处理 |
|---|---|---|
| 🟢 共用逻辑 | 与平台无关 | 搬进 `shared/domain/`，各平台共用 |
| 🔵 平台能力 | 只有系统 / 宿主能做 | 各平台写一份实现（Windows 现成的挪到平台层） |
| 🟡 混合 | 参数或返回值里混了两者 | 拆成「共用部分 + 平台部分」，界面看到的方法名保持不变 |

> 方法名与参数**不改**：界面代码不用动，这是阶段 1 能「发一次版本就验证」的前提。

## 2. 方法清单（36 个）

### 2.1 基础信息与设置（4）

| 方法 | 参数 | 用途 | 归属 | 网页 / 安卓注意 |
|---|---|---|---|---|
| `getAppInfo` | – | 版本号、数据版本、应用路径、种子库状态等 | 🟡 | 版本号改为构建期注入常量；路径类字段去掉或置空 |
| `setServerRegion` | `region: "jp" \| "cn"` | 切换游戏数据区服 | 🟡 | 存本地库即可（共用校验逻辑） |
| `setGenericBondParticipation` | `ids: number[]` | 「通用牵绊」参与计算的从者 | 🟢 | |
| `setNonParticipatingCraftIds` | `ids: number[]` | 不参与计算的礼装 | 🟢 | |

### 2.2 静态游戏数据（8）

| 方法 | 参数 | 用途 | 归属 | 网页 / 安卓注意 |
|---|---|---|---|---|
| `listServants` | `region` | 从者总表 | 🟡 | 改读随包静态库（WASM SQLite / JSON） |
| `getServant` | `id` | 单个从者详情 | 🟡 | ⚠️ 界面当前**未使用** |
| `getStageTraits` | `id, stage, region` | 某从者某阶段的特性 | 🟡 | |
| `getAllStageTraits` | `id, region` | 某从者全部阶段特性 | 🟡 | ⚠️ 界面当前**未使用** |
| `listBondCrafts` | – | 牵绊礼装表 | 🟡 | |
| `listAllCrafts` | – | 礼装总表 | 🟡 | |
| `getCostumeNames` | – | 灵衣名对照表 | 🟢 | 只读本地 JSON |
| `getEventBondBonuses` | – | 活动牵绊加成表 | 🟢 | |

### 2.3 个人数据（11，按账号隔离）

| 方法 | 参数 | 用途 | 归属 | 网页 / 安卓注意 |
|---|---|---|---|---|
| `getUserBox` | `accountId` | 读 Box | 🟡 | 桌面 SQLite ↔ 浏览器本地库 |
| `saveUserBox` | `entries, accountId` | 存 Box | 🟡 | 同上 |
| `resetUserBox` | `accountId` | 清空 Box | 🟡 | ⚠️ 界面当前**未使用** |
| `importCapture` | `content, accountId` | 导入抓包文本，解析成 Box | 🟡 | 解析逻辑共用，落库走适配器 |
| `getExclusions` | `accountId` | 读排除名单 | 🟡 | |
| `saveExclusions` | `exclusions, accountId` | 存排除名单 | 🟡 | |
| `listCustomCrafts` | – | 自定义礼装表 | 🟡 | |
| `saveCustomCrafts` | `items` | 存自定义礼装 | 🟡 | |
| `listUserTeams` | – | 已保存队伍 | 🟡 | |
| `saveUserTeam` | `team` | 存队伍 | 🟡 | |
| `deleteUserTeam` | `id` | 删队伍 | 🟡 | |

### 2.4 多账号（6）

| 方法 | 参数 | 用途 | 归属 |
|---|---|---|---|
| `listAccounts` | – | 账号列表 | 🟡 |
| `createAccount` | `payload` | 新建账号 | 🟡 |
| `renameAccount` | `payload` | 改名 | 🟡 |
| `duplicateAccount` | `payload` | 复制账号（含 Box / 排除） | 🟡 |
| `deleteAccount` | `id` | 删除账号 | 🟡 |
| `setActiveAccount` | `id` | 切换当前账号 | 🟡 |

### 2.5 计算引擎（4）

| 方法 | 参数 | 用途 | 归属 | 网页 / 安卓注意 |
|---|---|---|---|---|
| `calculate` | `payload`（见 `engine-protocol.md`） | 算出 Top N 队伍 | 🔵 | 桌面 = 起子进程；网页 / 安卓 = Worker + WASM，**同一份 JSON** |
| `cancelEngine` | – | 取消正在跑的计算 | 🔵 | 桌面 = kill 子进程；网页 = Worker 终止 |
| `updateData` | `{force}` | 联网更新游戏数据 | 🔵 | 网页 / 安卓不适用（随包发版） |
| `resetStaticData` | – | 重建静态数据 | 🔵 | 网页 / 安卓不适用或随包重置 |

### 2.6 系统能力与事件（3）

| 方法 | 参数 | 用途 | 归属 | 网页 / 安卓注意 |
|---|---|---|---|---|
| `copyText` | `text` | 写剪贴板（复制验证串 / 队伍） | 🔵 | `navigator.clipboard.writeText`，需降级方案 |
| `onEngineProgress` | `callback` | 订阅引擎进度 | 🟢 抽象 / 🔵 传输 | 桌面 = IPC 推送；网页 = Worker `postMessage` |
| `onMenuAction` | `callback` | 订阅系统菜单动作 | 🔵 | **网页没有系统菜单** → 界面里要有自己的入口按钮（设置 / 更新数据 / 重置） |

`onMenuAction` 的通道名：`menu:settings`、`menu:update-data`、`menu:update-data-force`、`menu:reset-database`。

## 3. 平台能力最小集（各平台都必须提供这些，否则功能缺块）

| 能力 | 桌面实现 | 网页 / 安卓实现 |
|---|---|---|
| 键值 / 数据存储 | SQLite（`db/fgo_data.db`） | 浏览器本地库（IndexedDB / OPFS）或原生 SQLite |
| 引擎执行 | 子进程（`engine.exe`） | Web Worker + WASM |
| 进度推送 | IPC 事件 | `postMessage` |
| 剪贴板 | Electron `clipboard` | `navigator.clipboard` + 兜底（选中文本提示用户手动复制） |
| 文件导入 | 对话框 / 粘贴文本 | `<input type="file">` / 粘贴 |
| 文件导出 | 保存对话框 | 浏览器下载（Blob） |
| 联网更新数据 | Python `urllib` | 不做（随包发版） |
| 自更新 | `updater.exe` | APK 覆盖安装；网页不涉及 |

## 4. 变更流程（阶段 3 之后生效）

1. 新增 / 修改桥接方法 → 先改本文件（名字、参数、返回、归属、错误），再改实现。
2. 版本号：`contracts/` 里每个文档头部标注版本（当前 `v0 初稿`）。
3. 破坏性变更（改名字 / 改参数）→ 必须同步改所有平台实现 + `renderer/`，并在提交说明里点名。
4. 一致性测试夹具先放本地（不进版本库），稳定后再挪进 `tests/`。
