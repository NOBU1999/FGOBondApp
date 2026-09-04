# FGO 牵绊推荐器

一个面向《Fate/Grand Order》的 **牵绊收益推荐系统**。

根据你拥有的从者、灵基阶段、满绊标记、Cost 上限、可用牵绊礼装，以及活动/个人加成，自动搜索并推荐高牵绊收益的 6 人队伍配置。

> 当前数据方向：**JP 日服**；界面为中文。

## 功能特点

- 从者 Box 管理：勾选拥有从者、设置灵基阶段/灵衣、满绊标记
- 队伍板：6 个位置（5 玩家 + 1 助战），支持固定从者/礼装
- 牵绊礼装：支持通用 5%、特性礼装、助战午茶类礼装
- 活动加成导入：
  - 从活动列表导入对应从者的个人加成（如 20%/50%）
  - 玛修等“全队光环”加成会单独写入光环字段，并在引擎中影响全队倍率
- 推荐策略：
  - 总牵绊最大化
  - 指定从者最大化
  - 均衡模式
- 搜索质量档位：快速 / 平衡 / 高
- 数据源：Atlas Academy JP 导出 + 本地中文翻译表

## 技术栈

- **Electron**：桌面壳、SQLite、主进程 IPC
- **Vue 3（全局版，无打包器）**：前端 UI
- **Python 3**：数据构建与牵绊收益计算引擎
- **SQLite**：本地数据库

## 目录结构

```text
.
├─ main/                 # Electron 主进程
│  ├─ index.js
│  ├─ ipc-handlers.js
│  ├─ database.js
│  └─ python-process.js
├─ preload.js            # preload 桥接
├─ renderer/             # 前端
│  ├─ index.html
│  ├─ app.js
│  ├─ style.css
│  └─ data/              # 前端用 trait 中文映射等
├─ python-engine/
│  └─ engine/
│     ├─ data_fetcher.py # Atlas 数据下载/DB 构建
│     ├─ event_bonus.py  # 活动加成解析（extraPassive）
│     ├─ calculator.py   # 倍率计算
│     ├─ search.py       # 队伍搜索
│     └─ main.py         # Python 引擎入口
├─ scripts/              # 翻译表/头像等辅助脚本
├─ docs/                 # 开发说明文档
└─ package.json
```

## 环境要求

- Windows
- Node.js（建议 18+，实际使用 Electron 最新版）
- Python 3.10+（开发环境使用 3.14）
- 首次运行/构建数据需要网络；也可使用已有本地缓存

## 本地运行（源码方式）

1. 安装依赖：

   ```powershell
   npm install
   ```

2. 准备数据库与活动加成表（首次需要下载 Atlas 导出，文件较大）：

   ```powershell
   cd python-engine

   # 构建 JP 从者/礼装 SQLite 数据库
   python -m engine.data_fetcher --region JP

   # 生成活动加成表 event_bond_bonus.json（放在项目根 db/ 旁边）
   python -c "from engine.event_bonus import update_event_bond_bonus; update_event_bond_bonus('JP', r'..\db\fgo_data.db', use_cache=True)"
   ```

   如果 Atlas 大文件已缓存在 `python-engine/.cache/raw/`，后续会很快。

3. 启动应用：

   ```powershell
   npm start
   ```

   > 开发模式下 Electron 会优先调用 `python-engine/engine_launcher.py`，不需要先打包 `engine.exe`。

4. （可选）补齐 JP 从者头像：

   ```powershell
   python scripts/fetch_missing_avatars.py --region JP --db db/fgo_data.db
   ```

## 打包便携版

仓库默认**不提交** `release/`、`node_modules/`、数据库等大文件。

本地打包参考：

```powershell
# 1. 先按上面方式准备好 db/fgo_data.db 和 python-engine/engine.exe
# 2. 构建 Python 引擎 exe
cd python-engine
python -m PyInstaller --clean --noconfirm pyinstaller.spec
Copy-Item .\dist\engine.exe .\engine.exe

# 3. 使用 electron-builder 生成便携目录（输出到 release/）
cd ..
npm run dist
```

详细打包说明见 `docs/Task5-打包集成说明.md`。

## 数据更新说明

- 从者/礼装数据来自 Atlas Academy JP `nice_servant.json` / `nice_equip.json`
- 活动 50%/20%/5% 从者加成来自 `nice_servant.json` 的 `extraPassive`，**不依赖本地 Chaldea 页面**
- 中文名翻译表由 Chaldea 本地数据生成，位于：
  - `python-engine/engine/data/name_translations.json`
  - `renderer/data/trait_names.js`

## 许可证

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)（见 `LICENSE`）。
