# data/ —— 数据表的唯一存放处

本目录放**由仓库维护、随包发布**的映射表与补丁表。
一句话规则：**要改这类表，只在这里改**；别处同名文件都是生成副本或运行期产物。

## 这里有什么

| 文件 | 内容 | 谁读 | 怎么刷新 |
|---|---|---|---|
| `trait_names.json` | 特性机器名 → 中文名（341 条） | `scripts/dev-tests/stage_trait_diff.py` | `python scripts/generate_trait_names.py`（联网拉 Atlas `nice_trait.json`，再套本地 Chaldea 译名） |
| `stage_traits_patch.json` | 灵基阶段/灵衣特性的人工补丁（11 位从者） | `engine-ts/src/dataFetch.ts` | 手工维护；改完跑 `node engine-ts/tests/engine-units.ts` |
| `name_translations.json` | 日文 → 简中译名表（1.8MB，脚本生成） | `engine-ts/src/dataFetch.ts`、`eventBonus.ts` | `python scripts/update_name_translations.py` |
| `event_names_extra.json` | 活动名手工补充（社区译名上线前的顶替） | `engine-ts/src/eventBonus.ts` | 手工维护；**别写进 `name_translations.json`**（那个是脚本生成的，会被覆盖） |

`renderer/data/trait_names.js` 是**生成副本**（由 `generate_trait_names.py` 从上面的 json 生成），
界面通过 `<script src="./data/trait_names.js">` 直接加载 —— 位置不动，别手改。

## 为什么有些表**不**放这里

| 表 | 现在在哪 | 原因 |
|---|---|---|
| 从者 / 礼装 / 特性 / 灵衣 的 7 张静态表 | `db/fgo_data.db` | 和用户数据共用一个 SQLite 文件；拆开要改引擎开库逻辑，收益小风险大 |
| 活动牵绊加成 | `db/event_bond_bonus.json` | **运行期产物**：「更新数据」每次重写它，且必须和用户运行库放同一个目录（桌面读 `dirname(db)/`、安卓读 `./db/`） |
| Atlas 原始抓取缓存（约 204MB） | `<应用根>/.cache/raw/` | **运行期产物**：不是数据表，是「更新数据」的分段下载缓存；删了要全量重下 |
| 灵衣中文名 | **数据库** `servant_costumes` 表 | 名字来自 Atlas raw 接口，由「更新数据」的 `refresh_costume_names` 写入；原先的本地 56 条死表已删 |

## 改动纪律

1. 改 `trait_names.json` / `stage_traits_patch.json` 后要重跑对应生成器/断言（见上表）。
2. 新增表时：**先想清楚它属于「随包发布」还是「运行期生成」**——后者放 `db/` 旁边，不要塞进这里。
3. 本目录会被打进发布包（桌面端由 `package.json` 的 `extraFiles` 带进 `dist/engine-ts` 旁边，
   界面侧经 `renderer/data/trait_names.js` 生成副本），放进来的文件不要带个人信息、不要带本地路径。
