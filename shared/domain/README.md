# shared/domain/ —— 共用业务逻辑

> 阶段 1 启用（目前是占位目录，**没有任何代码被调用**）。

## 放什么

与操作系统无关的「规则」与「流程」：

- 账号：新建 / 改名 / 复制 / 删除 / 切换当前账号 / 校验
- Box：增删改查、导入抓包后的合并与去重、从者信息补全
- 排除名单：从者排除、礼装排除、助战礼装排除
- 队伍：保存 / 删除 / 列表 / 排序
- 自定义礼装
- 数据迁移：从旧结构升级到新结构的规则
- 给界面用的"视图数据"组装（结果排序、统计口径）

典型来源：`main/database.js`、`main/ipc-handlers.js`、`main/runtime-db.js`、`main/db-reset.js` 里的
**业务规则**部分（不含连接、不含 `fs`）。

## 不放什么

- ❌ `require("electron")`、`ipcMain`、`dialog`、`BrowserWindow`
- ❌ `fs` / `path` / `child_process` / `__dirname` / `process.env`
- ❌ 具体的 SQLite 连接与文件路径（那是 `shared/storage/` 的接口，由平台实现）
- ❌ 任何"当前在什么系统上"的判断

## 怎么写（阶段 1 的约定）

- 纯函数优先：入参出参都是普通 JSON 可序列化的数据，方便测试与跨平台。
- 需要存取数据时，**依赖注入**存储接口（不直接 `require` 实现）：

```js
// 例：不是 require 具体数据库，而是接收一个实现了 storage 接口的对象
export function createAccountService(storage) {
  return {
    async list() { return storage.accounts.list(); },
    // ...规则写在这里
  };
}
```

- 单元测试与回归脚本放本地（不进版本库），改动前后各跑一次。

## 相关文档

- 接口出口清单：`shared/contracts/bridge-surface.md`
- 分类审计：`shared/README.md` 第四节
