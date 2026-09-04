# Task 3 Electron 主进程开发说明

## 新增结构

```
FGOBondApp/
├── package.json            # Electron 项目配置/打包配置
├── main/
│   ├── index.js            # 主进程入口、窗口生命周期
│   ├── paths.js            # 便携目录/开发目录路径解析
│   ├── database.js         # SQLite 数据访问（better-sqlite3/node:sqlite 自适应）
│   ├── python-process.js   # Python 引擎子进程管理
│   ├── ipc-handlers.js     # IPC 处理（DB/用户Box/引擎计算/更新）
│   └── menu.js             # 应用菜单
├── preload.js              # contextBridge 暴露 window.fgo API
└── renderer/
    └── index.html          # Phase 3 占位页面（可验证 IPC）
```

## 主进程职责

- 创建 1200×800 主窗口，最小 960×600
- 单实例锁
- 初始化 `db/fgo_data.db` 用户表
- 菜单：文件（导出方案/退出）、工具（更新数据/强制更新/重置数据库）、帮助（关于）
- 通过 `child_process` 管理 Python 引擎
- IPC 转发前端请求

## 路径处理

- 目录式便携版：`path.dirname(process.execPath)`
- electron-builder portable 单 exe：`PORTABLE_EXECUTABLE_DIR`
- 开发模式：项目根目录

```
appRoot/
├── FGO牵绊推荐器.exe
├── python-engine/engine.exe
├── db/fgo_data.db
└── 使用说明.txt
```

## SQLite

- 优先 `better-sqlite3`；如果未安装/未重建，则回退 Node 内置 `node:sqlite`
- 数据表由 Python 引擎初始化/更新
- 礼装统一只暴露 `craftType: "bond" | "other"`，不细分“其他礼装”的战斗类型
- 主进程只负责：
  - 读 servants/crafts/stage_traits
  - 写 user_box/user_teams
  - 更新数据时调用 Python `--mode=update`

## IPC API（供 Phase 4 渲染进程调用）

```js
window.fgo.getAppInfo()
window.fgo.listServants()
window.fgo.getServant(id)
window.fgo.getStageTraits(id, stage)
window.fgo.getAllStageTraits(id)
window.fgo.listBondCrafts()
window.fgo.listAllCrafts()

window.fgo.getUserBox()
window.fgo.saveUserBox(entries)
window.fgo.resetUserBox()
window.fgo.listUserTeams()
window.fgo.saveUserTeam(team)

window.fgo.calculate(payload)
window.fgo.updateData(force)
window.fgo.cancelEngine()

window.fgo.onEngineProgress(cb)
window.fgo.onMenuAction(cb)
```

## 验证

- JS 语法检查已通过。
- 依赖安装后：`npm start` 可启动 Electron 并加载占位页。
