# Task 5 打包与集成说明

## 最终产物

```
<项目根>/release/MyFGOApp/
├── FGO牵绊推荐器.exe
├── resources/
│   └── app.asar
├── python-engine/
│   └── engine.exe
├── db/
│   └── fgo_data.db
└── 使用说明.txt
```

- 免安装、绿色便携
- 双击 `FGO牵绊推荐器.exe` 即可运行
- 删除整个文件夹即卸载

## 打包命令

```bash
cd <项目根>

# 1. 重新打包 Python 引擎（如需）
cd python-engine
python -m PyInstaller --clean --noconfirm pyinstaller.spec
cd ..

# 2. 构建 Electron 便携目录
node_modules\.bin\electron-builder.cmd --win dir
```

构建完成后把 `release/win-unpacked` 重命名为 `release/MyFGOApp`。

## 验证结果（已实测）

- Electron 版本：44.1.1
- electron-builder：26.15.3
- 打包后启动成功 ✅
- SQLite 读取 443 名从者 ✅
- Python 引擎随包存在 ✅
- 数据库随包存在 ✅
- Vue 前端正常挂载 ✅
- appRoot 正确指向 `release/MyFGOApp`

## 注意

- 当前使用 Electron 默认图标；后续替换 `assets/icon.ico` 后可重新打包。
- `db/fgo_data.db` 已预置在包内；首次启动或菜单“工具 → 更新数据”可更新。
- 本工程未使用原生 Node 依赖，`node:sqlite` 已满足 SQLite 读写，避免 better-sqlite3 原生模块打包问题。
