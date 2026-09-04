# Task 2 计算引擎开发说明

## 新增/修改模块

```
python-engine/
├── engine/
│   ├── models.py          # 输入/输出数据结构与 JSON 解析
│   ├── calculator.py      # 单人倍率公式、队伍评估
│   ├── search.py          # 组合搜索/Top N 推荐
│   └── main.py            # stdin/stdout JSON 入口
├── engine_launcher.py     # PyInstaller 启动入口
├── pyinstaller.spec       # PyInstaller 打包配置
├── build_engine.ps1       # 一键构建 engine.exe
├── sample_request.json    # 示例请求
├── test_engine.py         # 冒烟测试
└── test_cases.py          # 固定/策略/Cost 用例
```

## 通信协议

启动：

```bash
engine.exe --mode=calculate --db <fgo_data.db>
```

- stdin：任务书 JSON
- stdout：结果 JSON
- stderr：`[progress] ...` 进度信息

也支持：

```bash
engine.exe --mode=update --db <fgo_data.db>
```

用于应用内“更新数据”。

## 计算逻辑

- 按任务书公式：
  - `total = (1 + 加成) × (1 + 通用礼装 + 助战礼装 + 特性礼装 + 满绊加成 + 活动加成) × (1 + 个人加成)`
- 最新决策：不区分前排/后排位置，忽略位置加成；仅保留助战/NPC 数量带来的全队 +4%/个。
- 满绊共享加成：玩家位每 1 名“开关一开启的满绊从者”= +25%。
- 特性礼装按“队伍中已装备的特性礼装”对每个玩家从者分别匹配。
- 助战从者不获得收益、不参与特性匹配、不占 Cost。
- Cost 只统计 5 名玩家从者及其礼装，助战不计。

## 搜索策略

- 固定从者/礼装先落位。
- 候选从者按启发式截断，控制组合数量；`target_max` 会强制目标从者进入候选池。
- 候选礼装只考虑非活动限定的牵绊加成礼装（数据层已新增 `is_event_limited` 标记）。
- 满破 2.5% 及以下的低价值牵绊礼装不进入推荐池。
- 搜索时按每个玩家组合计算“剩余 Cost 预算”，只评估能放得下的礼装组合，避免无谓枚举。
- 同一组玩家从者只保留最优礼装/位置组合，避免 Top20 全是同阵容换礼装。
- 低 Cost 会提前报错：`当前配置下最小Cost为XX，请提高上限`。
- 输出 Top N（默认 20），支持：
  - `total_max`：总倍率最高
  - `target_max`：指定从者倍率最高
  - `balanced`：总倍率与方差平衡

## 性能（本机验证）

- 8~20 名从者：0.1~0.3 秒
- 100 名从者大 Box：约 5.8 秒，返回 Top 20

## 打包

```powershell
cd python-engine
powershell -File build_engine.ps1
```

或：

```powershell
python -m PyInstaller --clean --noconfirm pyinstaller.spec
```

产物：`python-engine/engine.exe`。

`pyinstaller.spec` 已保留 NumPy 收集逻辑：若构建时已安装 NumPy，会自动 `collect_all('numpy')`；后续升级 NumPy 后重新打包即可。
