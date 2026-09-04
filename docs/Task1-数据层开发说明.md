# Task 1 数据层开发说明

## 目录

```
python-engine/
├── engine/
│   ├── __init__.py
│   ├── constants.py        # 区域/路径/阶段常量
│   ├── database.py         # SQLite DDL、写入、基础查询
│   ├── data_fetcher.py     # Atlas Academy API 拉取 + 全量建库
│   ├── queries.py          # UI/引擎查询接口
│   └── stage_trait_map.py  # 灵基阶段特性硬编码映射
├── scripts/
│   └── init_db.py          # 一键初始化/更新数据库
└── requirements.txt
```

## 运行

```bash
# 默认 CN 区，拉取 nice_servant.json + nice_equip.json 并写入 db/fgo_data.db
python python-engine/scripts/init_db.py

# 强制重新下载
python python-engine/scripts/init_db.py --fresh

# 指定区域/数据库
python python-engine/scripts/init_db.py --region NA --db D:/path/fgo_data.db
```

## 数据来源

- 从者：`https://api.atlasacademy.io/export/CN/nice_servant.json`
- 礼装：`https://api.atlasacademy.io/export/CN/nice_equip.json`
- 区域可用 `FGO_REGION` 或 `--region` 切换。

## 灵基阶段特性

- 优先使用 Atlas nice 数据的 `ascensionAdd.individuality.ascension`。
- 任务书中的特殊从者差异保存在 `stage_trait_map.py`，作为补丁叠加，确保覆盖已知从者。

## 礼装分类约定（需求确认）

本项目不是战斗模拟，礼装**不按战斗用途细分**。用户/UI/推荐逻辑只区分两类：

| 类型 | 含义 | 是否参与加成计算 |
|------|------|------------------|
| `bond` 牵绊礼装 | 提供牵绊点加成的礼装 | ✅ |
| `other` 其他礼装 | 所有非牵绊加成礼装 | ❌ 仅占位/消耗 Cost |

- 牵绊礼装内部仍有 `universal / trait / support` 等参数，那是给计算引擎用的，不是用户分类。
- 数据接口统一额外返回 `craft_type: "bond" | "other"`。
- 固定礼装位的 `type` 也只允许 `bond / other`。
- “其他礼装”不按战斗效果细分，但仍保留 `rarity` 和 `cost` 字段；UI 可按稀有度（1~5星）分组/筛选，因为 Cost 不同会影响组队上限。
- 每张礼装（包括“其他礼装”）都有独立 `rarity` / `cost`，引擎计算固定礼装占位时使用真实 Cost。

## 当前构建结果（CN 区，2026-09-03）

- 从者：443
- 灵基阶段特性行：约 3.8 万
- 礼装/装备：2449
- 检测出的牵绊加成礼装：30
- 其中包含任务书列出的全部关键礼装：迦勒底午餐时光、迦勒底午茶时光、来自ＮＦＦ的爱、迦勒底之晨、检查报告、手稿之翼、秘密任务、至诚的一针、献给幸福的新娘等。

## 已知说明

- 检测出的 30 张牵绊加成礼装中，包含少量“活动限定/活动关卡限定”礼装（如 200%/35% 的活动礼装）。数据层已用 `is_event_limited` 标记；计算引擎默认排除，UI 后续可增加“包含活动礼装”开关。
- 灵基阶段特性优先使用 API `ascensionAdd`，任务书硬编码映射保留在 `stage_trait_map.py` 作为兜底/权威差异清单。

## 应用内更新设计（已加入数据层）

- `update_database()`：先 HEAD Atlas 导出文件获取 ETag，与本地 `app_meta.servant_etag` 比较。
  - 无变化：返回 `{"status":"no_change","updated":false}`
  - 有变化：全量重建 `servants` / `servant_stage_traits` / `crafts`
- 用户数据表 `user_box` / `user_teams` 在更新时**不会清空**，因此新从者/新礼装加入不会覆盖用户配置。
- 命令示例：
  ```bash
  python python-engine/scripts/init_db.py --update
  python python-engine/scripts/init_db.py --update --force
  ```
- 后续 Electron 菜单“工具 → 更新数据”可直接调用上述 Python 更新模式，并在 UI 显示进度/结果。

## 新从者兼容性

- 新从者只要 Atlas Academy API 更新，应用内更新后即可出现在本地库。
- 数据构建没有按旧 ID 写死全量名单；灵基阶段特性优先从 API `ascensionAdd` 自动读取，硬编码映射只作为已知特殊从者的兜底/差异清单，不会阻止新从者入库。

## NumPy/打包说明

- `requirements.txt` 中 `numpy>=1.26` 未锁上限，保留升级安装 NumPy 后重新构建的余地。
- 数据层本身只用标准库（urllib/json/sqlite3），不需要 NumPy 即可运行。
