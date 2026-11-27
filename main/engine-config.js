"use strict";

/**
 * 引擎外壳设置（v0.3.8 第 2 项）
 *
 * `app_meta.engine_isolation = "1"` ⇒ 计算 / 检查 / 更新跑在**独立子进程**里；
 * 否则（默认/缺省）跑在 worker_threads 里，与主进程共享堆 —— 0.3.7 及以前的行为。
 *
 * 为什么存在数据库里：跟着个人数据一起走（导出/导入），而且主进程启动时就能读到。
 * 为什么"需重启"：外壳在**程序启动时**读一次就定下来（cached），运行期不换 ——
 * 免得同一会话里两套语义混着用，出问题时连"刚才跑的是哪套"都说不清。
 * 所以「保存了」和「现在在跑哪套」是两件事：界面两个都显示。
 */
const database = require("./database");
const { getDbPath } = require("./paths");

const KEY = "engine_isolation";
let cached = null;

function readFromDb() {
  try {
    const db = database.open(getDbPath(), { attachGame: false });
    try {
      const value = database.getMetaValue(db, KEY);
      return String(value || "") === "1";
    } finally {
      db.close();
    }
  } catch (_) {
    return false;
  }
}

/** 当前**正在运行**的外壳（程序启动后第一次调用时读库并固定） */
function isEngineIsolated() {
  if (cached === null) cached = readFromDb();
  return cached;
}

function savedValue() {
  return readFromDb();
}

/** 状态：正在跑哪套 + 存的是什么 + 要不要重启 */
function getEngineIsolation() {
  const active = isEngineIsolated();
  const saved = savedValue();
  return {
    ok: true,
    supported: true,
    isolated: active,
    saved,
    restartRequired: active !== saved,
  };
}

/** 只写库，不动当前会话的外壳（真要切换得重启程序） */
function setEngineIsolated(enabled) {
  const value = enabled ? "1" : "0";
  const db = database.open(getDbPath(), { attachGame: false });
  try {
    database.setMetaValue(db, KEY, value);
  } finally {
    db.close();
  }
  const active = isEngineIsolated();
  return {
    ok: true,
    isolated: active,
    saved: Boolean(enabled),
    restartRequired: active !== Boolean(enabled),
  };
}

/** 供宿主自检 / 测试重置内存缓存（模拟"重启"） */
function resetEngineIsolationCache() {
  cached = null;
}

module.exports = {
  KEY,
  isEngineIsolated,
  getEngineIsolation,
  setEngineIsolated,
  resetEngineIsolationCache,
};
