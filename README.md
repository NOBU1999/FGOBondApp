# FGO 牵绊推荐器

面向《Fate/Grand Order》的本地牵绊收益推荐工具。程序会根据你的从者持有情况、灵基状态、Cost 上限与可用礼装，自动搜索并推荐高牵绊收益的队伍配置。

> 当前面向 JP 日服数据，界面为中文。

## 功能特性

- **多账号**：一套程序可维护多个账号，每个账号独立保存「用于计算的 Box + 排除列表」，左上角下拉即可切换
- **从者管理**：维护个人 Box、灵基阶段/灵衣、满绊状态与个人加成
- **队伍配置**：6 人队伍板（5 玩家 + 1 助战），支持固定从者与礼装
- **牵绊礼装**：支持通用、特性条件与助战位礼装
- **活动加成**：支持按活动导入从者加成，并处理全队光环类效果
- **推荐策略**：总牵绊最大化、指定从者最大化、均衡模式
- **搜索档位**：快速 / 平衡 / 高，可按需平衡耗时与覆盖范围
- **本地数据**：数据保存在本地 SQLite，无需联网即可计算
- **升级不丢数据**：发布包只带静态数据种子库，个人数据文件不在包内，解压覆盖不会丢账号与 Box
- **独立更新器**：`updater.exe` 可直接安装 zip / 7z 新包（校验包内声明的兼容版本区间），
  失败可回滚，主程序打不开时也能用它更新

> ⚠️ **更新系统目前处于测试阶段**：安装 / 回滚流程仍在验证中，
> 首次使用前建议先备份整个程序文件夹（至少备份 `db` 文件夹）；
> 出问题可双击 `updater.exe` 回滚，或直接解压旧版发布包覆盖（个人数据不会丢）。

## 技术架构

| 层 | 技术 |
|---|---|
| 桌面壳 / IPC / SQLite | Electron |
| 前端 UI | Vue 3（全局构建，无打包器） |
| 数据构建 / 收益计算 | Python 3 |
| 本地存储 | SQLite |

```text
.
├─ main/                 # Electron 主进程（含 app-updater.js 更新器接线）
├─ preload.js            # 渲染进程桥接
├─ renderer/             # 前端 UI
├─ python-engine/
│   └─ engine/           # Python 数据与计算引擎
├─ updater/              # 独立更新器（updater.py + PyInstaller spec）
├─ scripts/              # 数据/翻译/资源/发布辅助脚本
├─ docs/                 # 开发与集成文档
└─ package.json
```

## 环境要求

- Windows
- Node.js（建议 18+）
- Python 3.10+
- 首次构建本地数据时需要网络连接

## 快速开始

### 1. 安装依赖

```powershell
npm install
```

### 2. 准备本地数据

首次运行需要从 Atlas Academy 下载 JP 数据并生成数据库：

```powershell
cd python-engine

# 构建从者/礼装 SQLite 数据库
python -m engine.data_fetcher --region JP

# 生成活动加成表
python -c "from engine.event_bonus import update_event_bond_bonus; update_event_bond_bonus('JP', r'..\db\fgo_data.db', use_cache=True)"
```

Atlas 大文件会缓存到 `python-engine/.cache/raw/`，后续更新会更快。

### 3. 启动应用

```powershell
npm start
```

开发模式会直接调用 Python 源码引擎，无需预先打包 `engine.exe`。

### 4. 可选：补齐从者头像

```powershell
python scripts/fetch_missing_avatars.py --region JP --db db/fgo_data.db
```

## 反馈验证串

计算完成后，可从结果区复制“验证串”用于向开发者反馈问题。该串包含本次计算参数、搜索所需数据快照和结果基线，使用 PPMd + Base64URL 编码，不加密。

验证/复现工具仅开发者本地保留，不随公开仓库发布。验证串中可能包含个人 Box 数据，分享前请自行确认可以公开。

## 打包发布

`release/`、`node_modules/`、数据库等运行产物不会进入源码仓库。

打包时静态数据会以 `db/fgo_data.seed.db` 的形式进入发布包，运行库 `db/fgo_data.db`
（账号 / Box / 排除等个人数据）**不会**被打包，因此用户直接解压覆盖升级不会丢数据；
启动时若检测到种子库更新，会自动以种子库为基底重建运行库并搬移个人数据，
旧库备份保留在 `db/backup/`。

本地打包参考：

```powershell
# 1) 构建 Python 引擎
cd python-engine
python -m PyInstaller --clean --noconfirm pyinstaller.spec
Copy-Item .\dist\engine.exe .\engine.exe
cd ..

# 2) 构建独立更新器（内置 7z，支持 zip/7z 安装包）
powershell -ExecutionPolicy Bypass -File updater\build_updater.ps1

# 3) 构建 Electron 便携目录
npm run dist

# 4) 写入版本元数据 + 投放 updater.exe（发布包必须带 version.json / update.json）
python scripts/make_release_meta.py --notes "本次更新说明"

# 5) 发布前隐私清理（会删除便携目录里的运行时库，并检查发布目录）
python scripts/privacy_clean.py
```

`update.json` 里的 `compatibleFrom` / `compatibleTo` 表示**兼容区间**：
该包可直接安装在任何落在这个区间内的版本上（区间内没有结构破坏性变更），
超出区间只做警告 + 二次确认，不硬拦。

更新器自身的行为由 `scripts/dev-tests/test_updater.py` 回归覆盖
（正常安装 / 不保留安装包 / 无外层目录 zip / 7z / 兼容区间外 / 坏包 / 回滚 / 个人数据保留）。

详细打包说明见 [`docs/Task5-打包集成说明.md`](docs/Task5-打包集成说明.md)。

## 数据来源与致谢

- 游戏数据来自 **Atlas Academy**：[fgo-game-data-api](https://github.com/atlasacademy/fgo-game-data-api)
- 中文名称与部分翻译映射生成时参考 **Chaldea**：[chaldea-center/chaldea](https://github.com/chaldea-center/chaldea)
- 两者均以 AGPL-3.0 许可发布，本项目同样使用 AGPL-3.0
- 游戏素材、文本与角色数据版权归 TYPE-MOON / FGO Project 等相关权利方所有
- 本项目仅用于非商业学习与工具用途

更多数据归属说明见 [`NOTICE`](NOTICE)。

## 许可证

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html)，详见 [`LICENSE`](LICENSE)。
