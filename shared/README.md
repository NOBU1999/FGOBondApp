# shared/ —— 公用区（跨平台共用代码）

> 阶段 0 产物（全平台化第 1 步）。
> **本目录目前只有文档与骨架，不含任何被调用的代码**，所以 Windows 版行为与 v0.1.10 **完全一致**（没动过一行现有逻辑）。

## 一、为什么要有这个目录

现在的程序像一个**只有堂食的饭店**：菜谱（计算逻辑）、收银台（账号 / Box / 排除名单）、店面装修（界面），
全都长在「Windows 这家店」里。

我们要开第二家店（安卓 APK）。做法**不是再写一家店**，而是把菜谱与收银台搬进**中央厨房**（本目录），两个店面共用。
否则以后每改一个功能都要改两遍，两边很快会走远（**分叉**）——这是最大的坑。

硬约束：**网页版只作内部使用**（不对外分发），它是 APK 的内核与内测手段。
所以共用区的唯一目标：**Windows 便携版 + Android APK 两个下载型产物，一份逻辑。**

## 二、目录骨架

| 目录 | 放什么 | 现状 | 启用阶段 |
|---|---|---|---|
| `contracts/` | 契约文档：桥接接口清单、宿主 ↔ 引擎协议 | ✅ 已有内容 | 0（本阶段） |
| `domain/` | 与系统无关的业务逻辑：账号、Box、排除名单、队伍、导入解析、迁移规则 | 📄 占位 | 1 |
| `storage/` | 数据存取**接口**（只定接口，不做实现） | 📄 占位 | 1 |
| `engine/` | 引擎调用**接口**：请求 / 结果 / 进度 / 取消 | 📄 占位 | 3–4 |
| `ui/` | 共用界面（Vue） | 📄 占位 | 4 |

> `ui/` 为什么空着：阶段 2 做窄屏适配时**直接在 `renderer/` 上改**，不折腾搬家；
> 等阶段 4 真的要跑第二个宿主时再搬进 `shared/ui/`（同样的代码，只换外壳）。

每个子目录的 README 里写了「放什么 / 不放什么 / 接口长什么样」。

## 三、架构三条规矩（小抄）

1. **新功能先问「能不能写进共用区」**，能就写共用区，别一开始就写进平台专属区。
2. **共用区不许直接碰系统能力**（读硬盘、起进程、装更新、读系统路径、弹系统菜单…），需要就通过接口交给平台层代劳。
3. **每次更新只改共用区**；出包时把共用区覆盖到各平台工程。

自动检查：`npm run check:platform`
（扫描 `shared/` → `renderer/` → `python-engine/engine/`，把违规点连同行号列出来；
「错误级」返回非 0 退出码，将来可直接进 CI；「警告级」只提示，不拦。）

## 四、审计结论：现有文件怎么分类（阶段 0 的核心产出）

### A. 已经是「共用」的（阶段 1 基本原样搬，零改造）

| 文件 | 行数 | 为什么能直接共用 | 备注 |
|---|---|---|---|
| `python-engine/engine/calculator.py` | 881 | 纯 Python，只用标准库（json / sqlite3 / dataclasses） | 游戏数据由 `DataContext` 传入 |
| `python-engine/engine/search.py` | 2289 | 只用 `itertools` / `math` / `time` | 搜索与精算核心 |
| `python-engine/engine/models.py` | 269 | 纯数据类 + `parse_request` | 请求 / 结果结构 |
| `python-engine/engine/queries.py` | 100 | SQL 查询语句 | 依赖 `database.py`，阶段 1 一起搬 |
| `python-engine/engine/event_bonus.py` | 310 | 只读本地 JSON | 活动加成 |
| `python-engine/engine/stage_trait_map.py` | 126 | 纯映射表 | 追加特性覆盖 |
| `python-engine/engine/verification.py` | 386 | 纯算法（zlib / base64 / hashlib） | `pyppmd`、`cryptography` 为可选依赖，缺失时降级 |
| `python-engine/engine/constants.py` | 55 | 常量为主 | 路径部分阶段 1 要参数化 |
| `renderer/app.js` | ~4150 | **实测零 Electron 依赖**：只用 `window.fgo.*`，没有 `require` / `ipcRenderer` / `process` | 唯一例外：2 处 `localStorage`（警告级，阶段 1 收进适配器） |
| `renderer/index.html`、`renderer/style.css` | | 纯网页 | |
| `renderer/data/*.json`、`renderer/vendor/vue.global.prod.js` | | 静态数据 / 第三方库 | |

> **好消息**：引擎核心**零第三方依赖**。`requirements.txt` 里写的 `numpy` / `scipy` 实测一行都没用到（全文搜索 0 处），可以清理。
> 这是「引擎能搬进浏览器（WASM）」的关键前提——只差 `sqlite3` 与文件路径。

### B. 平台专属（留在 Windows 层，将来各平台各写一份）

| 文件 | 行数 | 用到的平台能力 |
|---|---|---|
| `main/index.js` | 343 | Electron 生命周期、窗口创建 |
| `main/menu.js` | 206 | 系统菜单、对话框、打开外部浏览器 |
| `main/paths.js` | 49 | 定位 exe / 应用根目录（便携版目录、开发目录） |
| `main/python-process.js` | 181 | 起子进程（`spawn`）、管道读写 |
| `main/app-updater.js` | 271 | 拉起 `updater.exe` 自更新 |
| `preload.js` | 76 | 桥接实现（`contextBridge` + `ipcRenderer`） |
| `updater/` | | Windows 独立更新器（Python + PyInstaller） |
| `python-engine/data_fetcher.py` | 813 | 联网下载游戏数据（`urllib`） |
| `python-engine/engine_launcher.py`、`build_engine.ps1`、`*.spec` | | PyInstaller 打包 |
| `scripts/*.py` | | 开发 / 构建期工具 |
| `使用说明.txt` | | 桌面端文案（安卓要另写一份） |

### C. 混合体（阶段 1 主要工作量：把「规则」与「系统操作」拆开）

| 文件 | 行数 | 拆法 |
|---|---|---|
| `main/database.js` | 972 | SQL 语句 + 业务规则 → `shared/domain/`；连接与文件路径 → `shared/storage/` 接口 + Windows 实现（`better-sqlite3`，回退 `node:sqlite`） |
| `main/ipc-handlers.js` | 381 | 参数校验与编排 → `shared/domain/`；`ipcMain.handle` 注册 → 平台层薄壳 |
| `main/runtime-db.js` | 344 | 「什么时候重建 / 迁移种子库」的规则 → 共用；`fs` 复制删除 → 平台层 |
| `main/db-reset.js` | 161 | 同上（清空静态表并重建） |
| `python-engine/engine/database.py` | 419 | 建表与连接 → `shared/storage/` 的引擎侧实现；SQL 归共用 |

### D. 数据与资产

- **静态游戏数据**（从者 / 礼装 / 特性 / 活动…）：随包分发 → 共用。
- **个人数据**（账号 / Box / 排除 / 队伍 / 自定义礼装）：桌面存 SQLite；网页与安卓存浏览器本地库 →
  **同一套接口，两种实现**。
- **发布资产**：Windows 便携版 `.7z` / `.zip`、安卓 `.apk`、安卓签名密钥（单独双备份）。

## 五、注意事项

1. `package.json` 的 `build.files` 目前是 `main/**` + `preload.js` + `renderer/**`；
   **阶段 1 一旦真正引用 `shared/`，必须把 `shared/**/*` 加进去**，否则打进 Electron 包会漏文件。
2. 阶段 0 **不改任何现有逻辑文件**（只新增本目录、检查脚本，以及 `package.json` 一行 script）。
3. 共用区对外的**唯一出口**是 `contracts/bridge-surface.md` 里那 36 个方法；界面不许绕过它去够平台能力。
4. 平台专属代码将来统一挪到 `platforms/<平台>/`（Windows / web / android），本阶段**先不建**，避免留下空壳目录。
