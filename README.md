# FGO 牵绊推荐器

面向《Fate/Grand Order》的本地牵绊收益推荐工具。程序会根据你的从者持有情况、灵基状态、Cost 上限与可用礼装，自动搜索并推荐高牵绊收益的队伍配置。

> 当前面向 JP 日服数据，界面为中文。

## 功能特性

- **从者管理**：维护个人 Box、灵基阶段/灵衣、满绊状态与个人加成
- **队伍配置**：6 人队伍板（5 玩家 + 1 助战），支持固定从者与礼装
- **牵绊礼装**：支持通用、特性条件与助战位礼装
- **活动加成**：支持按活动导入从者加成，并处理全队光环类效果
- **推荐策略**：总牵绊最大化、指定从者最大化、均衡模式
- **搜索档位**：快速 / 平衡 / 高，可按需平衡耗时与覆盖范围
- **本地数据**：数据保存在本地 SQLite，无需联网即可计算

## 技术架构

| 层 | 技术 |
|---|---|
| 桌面壳 / IPC / SQLite | Electron |
| 前端 UI | Vue 3（全局构建，无打包器） |
| 数据构建 / 收益计算 | Python 3 |
| 本地存储 | SQLite |

```text
.
├─ main/                 # Electron 主进程
├─ preload.js            # 渲染进程桥接
├─ renderer/             # 前端 UI
├─ python-engine/
│   └─ engine/           # Python 数据与计算引擎
├─ scripts/              # 数据/翻译/资源辅助脚本
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

## 打包发布

`release/`、`node_modules/`、数据库等运行产物不会进入源码仓库。

本地打包参考：

```powershell
# 构建 Python 引擎
cd python-engine
python -m PyInstaller --clean --noconfirm pyinstaller.spec
Copy-Item .\dist\engine.exe .\engine.exe

# 构建 Electron 便携目录
cd ..
npm run dist
```

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
