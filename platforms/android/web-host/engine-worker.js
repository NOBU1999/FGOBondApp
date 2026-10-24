/**
 * 安卓（WebView）里的**计算 Worker** —— classic worker（只有它有 `importScripts`）。
 *
 * 为什么单独一个文件：sql.js 的胶水是**传统脚本**（挂 `self.initSqlJs`），ESM 里 import 不到；
 * 而引擎 bundle 是 esbuild 的 IIFE（`self.FgoEngine`）。3 行 importScripts 之后，
 * 这里只负责「消息 → 引擎调用 → 消息」的翻译，引擎内部一行都不用改。
 *
 * 协议（与 boot.js 约定，见 shared/contracts/engine-protocol.md）：
 *   收：{ id?, type: "calc", dbBytes: ArrayBuffer(transfer), request: Object, createdAt? }
 *       { type: "cancel" }                       ← 超级模式：引擎收尾后返回 status="partial"
 *   回：{ type: "ready" }                        ← 胶水 + 引擎都加载完
 *       { type: "progress", line }
 *       { type: "result", payload }
 *       { type: "error", message }
 *
 * ⚠️ 取消必须靠「让出事件循环」才收得到：搜索是同步大循环，主线程的 postMessage 只有
 *    Worker 让出的时候才会被派发 ⇒ 调用引擎时固定传 `yieldEveryMs`，别删。
 */
(function () {
  "use strict";

  // ⚠️ 本文件在 `platforms/android/web-host/` 下 ⇒ 回到网页根要退 **三级**
  var SQLJS_DIR = "../../../vendor/sqljs/";
  var ENGINE_URL = "../../../engine-ts/web.js";
  var YIELD_EVERY_MS = 250;

  var cancelled = false;
  var busy = false;

  function absUrl(rel) {
    try {
      return new URL(rel, self.location.href).href;
    } catch (_) {
      return rel;
    }
  }

  function fail(message) {
    try {
      self.postMessage({ type: "error", message: String(message) });
    } catch (_) {
      /* 连消息都发不出去就只能放弃 */
    }
  }

  // ---- ① sql.js 胶水（提供 self.initSqlJs） ----
  try {
    self.importScripts(absUrl(SQLJS_DIR + "sql-wasm.js"));
  } catch (err) {
    fail("sql.js 加载失败：" + ((err && err.message) || err));
    return;
  }
  var wasmUrl = absUrl(SQLJS_DIR + "sql-wasm.wasm");
  self.__FGO_LOAD_SQLJS__ = function (opts) {
    var url = (opts && opts.wasmUrl) || wasmUrl;
    return self.initSqlJs({ locateFile: function () { return url; } });
  };

  // ---- ② 引擎（IIFE：self.FgoEngine = { runCalc, buildPayload, ... }） ----
  try {
    self.importScripts(absUrl(ENGINE_URL));
  } catch (err) {
    fail("引擎加载失败：" + ((err && err.message) || err));
    return;
  }
  var FgoEngine = self.FgoEngine;
  if (!FgoEngine || typeof FgoEngine.runCalc !== "function") {
    fail("引擎 bundle 里没有 runCalc（engine-ts/web.js 版本不匹配？）");
    return;
  }

  // ---- ③ 消息处理 ----
  self.onmessage = function (event) {
    var data = event && event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "cancel") {
      // 只置标志：引擎在 checkCancel 里读到它，超级模式体面收尾、普通模式抛「已取消」
      cancelled = true;
      return;
    }

    if (data.type !== "calc") return;
    if (busy) {
      fail("引擎正在运行，请先等待当前计算结束");
      return;
    }
    busy = true;
    cancelled = false;

    var dbBytes = data.dbBytes;
    var bytes = dbBytes instanceof Uint8Array ? dbBytes : new Uint8Array(dbBytes);
    var started = Date.now();

    FgoEngine.runCalc({
      dbBytes: bytes,
      request: data.request || {},
      createdAt: data.createdAt,
      onProgress: function (msg) {
        try {
          self.postMessage({ type: "progress", line: String(msg == null ? "" : msg) });
        } catch (_) {
          /* 进度发不出去不影响计算 */
        }
      },
      shouldCancel: function () {
        return cancelled;
      },
      yieldEveryMs: YIELD_EVERY_MS,
    })
      .then(function (payload) {
        busy = false;
        payload._hostElapsed = Number(((Date.now() - started) / 1000).toFixed(3));
        self.postMessage({ type: "result", payload: payload });
      })
      .catch(function (err) {
        busy = false;
        var message = (err && err.message) || String(err);
        fail(message);
      });
  };

  self.postMessage({ type: "ready" });
})();
