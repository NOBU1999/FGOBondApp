# 存储端口 `sql`（共用层访问数据的唯一方式）

> 阶段 1 产物。共用层（`shared/domain/`）**不许自己开数据库**，只拿到一个 `sql` 端口对象。
> 谁能提供这个端口：桌面端（`main/database.js`，better-sqlite3 / node:sqlite）、
> 网页端（阶段 4，WASM SQLite）、安卓端（阶段 5，原生 SQLite）。

## 为什么是「SQL 形状」而不是「仓储形状」

通常做法是让共用层只讲业务（"给我这个账号的 Box"），把 SQL 全部推进平台实现。
本项目**故意不那么做**，原因：

1. 计算引擎（Python / WASM）自己就要读同一个 SQLite 文件里的静态数据表，
   所以三个平台**都必须有真 SQLite** —— 数据库引擎不是可替换的细节，而是既定前提。
2. SQL 语句是业务语义的一部分（例如"复制账号"要 `INSERT OR REPLACE ... SELECT`）。
   把它推到平台层，等于把业务规则复制三份 —— 正是我们要避免的分叉。
3. 端口越小，平台实现越薄、越不容易写错。

代价：将来若要换掉 SQLite（比如改用 IndexedDB），要改的是共用层的 SQL，
而不是只改平台实现。**目前接受这个代价**（阶段 6 再评估）。

## 端口定义

```js
sql.all(sqlText, params = [])   // → 行数组；每行是「普通对象副本」（不是驱动原始行）
sql.get(sqlText, params = [])   // → 单行 | undefined
sql.run(sqlText, params = [])   // → 驱动原始结果 { changes, lastInsertRowid }（不许改写）
sql.exec(sqlText)               // → void（建表、PRAGMA、多语句）
sql.tx(fn)                      // → 事务里执行 fn，返回 fn 的返回值；抛错自动 ROLLBACK
```

## 硬性要求（平台实现必须遵守）

| # | 要求 | 原因 |
|---|---|---|
| 1 | `params` 一律是**数组**，透传给驱动 | 现有代码全部用位置参数 `?` |
| 2 | `run` 的返回值**原样**返回，不要把 BigInt 转 Number、不要补字段 | 调用方依赖 `lastInsertRowid` 的类型一致性 |
| 3 | `all` 必须返回**普通对象副本** | node:sqlite 的行对象与 better-sqlite3 行为不同，副本抹平差异 |
| 4 | `tx` 必须支持"抛错即回滚"，且**不许嵌套** | 嵌套 BEGIN 会报错；共用层已保证不嵌套 |
| 5 | 不许多送 / 少送参数（例如不要偷偷补 `null`） | 保持与旧实现逐字节一致 |

## 共用层的责任

- 所有 SQL 文本写在 `shared/domain/` 里（可被三个平台复用）。
- 不出现 `require` / `import` 平台模块；不出现 `fs`、`path`、`process`、`__dirname`。
- 事务用 `sql.tx(...)`，不要手写 BEGIN/COMMIT（那是实现细节）。

## 现状

| 平台 | 实现位置 | 状态 |
|---|---|---|
| Windows | `main/database.js` 的 `createSqlPort()` | ✅ 阶段 1 已落地（better-sqlite3 优先，回退 node:sqlite） |
| 网页 | 阶段 4：WASM SQLite | ⛔ 未开始 |
| 安卓 | 阶段 5：Capacitor + 原生 SQLite | ⛔ 未开始 |

## 迁移进度（阶段 1）

- [x] 端口定义 + Windows 实现
- [x] `meta`（app_meta 键值 + 区服 / 通用牵绊 / 不参与礼装）
- [x] `accounts`（账号 CRUD + 复制 + 旧数据迁移）
- [ ] `box`、`exclusions`、`customCrafts`、`teams`、`staticData`
- [ ] 引擎侧 `database.py` 只读访问归位（阶段 3）
