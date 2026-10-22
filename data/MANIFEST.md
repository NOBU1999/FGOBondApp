# data/ —— 数据表的唯一存放处

本目录放**由仓库维护、随包发布**的映射表与补丁表。
一句话规则：**要改这类表，只在这里改**；别处同名文件都是生成副本或运行期产物。

## 这里有什么

| 文件 | 内容 | 谁读 | 怎么刷新 |
|---|---|---|---|
| `trait_names.json` | 特性机器名 → 中文名（341 条） | `scripts/dev-tests/stage_trait_diff.py` | `python scripts/generate_trait_names.py`（联网拉 Atlas `nice_trait.json`，再套本地 Chaldea 译名） |
| `stage_traits_patch.json` | 灵基阶段/灵衣特性的人工补丁（11 位从者） | `python-engine/engine/stage_trait_map.py` | 手工维护；改完跑 `python python-engine/tests/engine_units.py` |

`renderer/data/trait_names.js` 是**生成副本**（由 `generate_trait_names.py` 从上面的 json 生成），
界面通过 `<script src="./data/trait_names.js">` 直接加载 —— 位置不动，别手改。

## 为什么有些表**不**放这里

| 表 | 现在在哪 | 原因 |
|---|---|---|
| 从者 / 礼装 / 特性 / 灵衣 的 7 张静态表 | `db/fgo_data.db` | 和用户数据共用一个 SQLite 文件；拆开要改引擎开库逻辑，收益小风险大 |
| 活动牵绊加成 | `db/event_bond_bonus.json` | **运行期产物**：「更新数据」每次重写它，且必须和用户运行库放同一个目录（桌面读 `dirname(db)/`、安卓读 `./db/`） |
| 译名表（1.8MB）`name_translations.json` | `python-engine/engine/data/` | PyInstaller 打进 `engine.exe` 的固定布局；挪出来要改 spec 与冻结态解析，容易只在真机上炸 |
| 活动名手工补充 `event_names_extra.json` | `python-engine/engine/data/` | 同上（引擎内部附带表） |
| 灵衣中文名 | **数据库** `servant_costumes` 表 | 名字来自 Atlas raw 接口，由「更新数据」的 `refresh_costume_names` 写入；原先的本地 56 条死表已删 |

## 改动纪律

1. 改 `trait_names.json` / `stage_traits_patch.json` 后要重跑对应生成器/断言（见上表）。
2. 新增表时：**先想清楚它属于「随包发布」还是「运行期生成」**——后者放 `db/` 旁边，不要塞进这里。
3. 本目录会被打进发布包（引擎侧表经 `pyinstaller.spec`，界面侧经生成副本），
   放进来的文件不要带个人信息、不要带本地路径。
