"use strict";

const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");
const { Worker } = require("worker_threads");
const { getAppRoot } = require("./paths");

/**
 * TypeScript 计算引擎（`engine-ts`）的宿主封装。
 *
 * 与 `PythonProcess` **同一套对外接口**（calculate / check / update / stop / stderrTail，
 * 以及 `progress` / `error` 事件），所以上层（ipc-handlers / db-reset）只需换构造处。
 *
 * 实现差异：不是 spawn 子进程，而是 `worker_threads` 里跑 `dist/engine-ts/worker.mjs`；
 * 「取消」从"杀进程"变成 `worker.terminate()`（语义等价：丢掉这次计算）。
 */
class EngineTsProcess extends EventEmitter {
  constructor({ dbPath } = {}) {
    super();
    this.dbPath = dbPath;
    this.worker = null;
    this._stderrTail = "";
    this._settled = false;
  }

  /** 引擎日志尾部：上层失败时拿它写诊断日志（与 PythonProcess 同口径） */
  get stderrTail() {
    return this._stderrTail.trim();
  }

  _bundlePath() {
    return path.join(getAppRoot(), "dist", "engine-ts", "worker.mjs");
  }

  _appendLog(line) {
    this._stderrTail = (this._stderrTail + line + "\n").slice(-8192);
  }

  _spawn(mode, payload) {
    if (this.worker) throw new Error("计算引擎已经在运行");
    const bundle = this._bundlePath();
    if (!fs.existsSync(bundle)) {
      throw new Error(`未找到 TypeScript 引擎产物 ${bundle}，请先运行 npm run build:engine-ts`);
    }
    const worker = new Worker(bundle, {
      workerData: {
        appRoot: getAppRoot(),
        dbPath: this.dbPath,
        mode,
        payload: payload === undefined ? null : payload,
      },
    });
    this.worker = worker;
    this._stderrTail = "";
    this._settled = false;

    worker.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "progress") {
        const line = String(msg.line ?? "").trim();
        if (line) {
          // 与 PythonProcess 一致：日志尾部包含进度行（失败时要靠它定位）
          this._appendLog(line);
          this.emit("progress", line);
        }
        return;
      }
      if (msg.type === "result") {
        this._finish(null, msg.payload);
        return;
      }
      if (msg.type === "error") {
        this._finish(new Error(String(msg.message || "计算失败")));
      }
    });

    worker.on("error", (err) => {
      this._appendLog(String(err && err.stack ? err.stack : err));
      this._finish(err);
    });

    worker.on("exit", (code) => {
      // 正常路径已经 settled（result/error 消息先到）；这里只兜"没回消息就退出"
      if (this._settled) return;
      if (code === 0) {
        this._finish(new Error("计算引擎没有返回输出"));
      } else {
        const tail = this._stderrTail.trim();
        this._finish(new Error(tail || `计算引擎退出码 ${code}`));
      }
    });
  }

  _finish(err, payload) {
    if (this._settled) return;
    this._settled = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      // 不再需要消息：主动收掉 worker（terminate 是异步的，不阻塞解析）
      Promise.resolve(worker.terminate()).catch(() => {});
    }
    this._resolve(err, payload);
  }

  run(mode, payload) {
    return new Promise((resolve, reject) => {
      if (this.worker) {
        reject(new Error("计算引擎已经在运行"));
        return;
      }
      this._resolve = (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          if (result && result.status === "error") {
            reject(new Error(result.message || "计算失败"));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(e);
        }
      };
      try {
        this._spawn(mode, payload);
      } catch (err) {
        this._settled = true;
        this.worker = null;
        reject(err);
      }
    });
  }

  calculate(payload) {
    return this.run("calculate", payload);
  }

  /** 只检查远程是否有新数据（HEAD，不下载） */
  check() {
    return this.run("check");
  }

  /** 全量重建静态数据（保留个人数据） */
  update() {
    return this.run("update");
  }

  stop() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    try {
      worker.terminate();
    } catch (_) {
      // ignore
    }
    // ⚠️ 必须把 pending 的 Promise 结掉：不然调用方（ipc handler）会一直 await 着
    this._finish(new Error("已停止计算"));
  }
}

module.exports = { EngineTsProcess };
