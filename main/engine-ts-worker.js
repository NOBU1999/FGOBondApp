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
      // 堆上限：默认值（64 位约 4GB）不够极端形状用。实测「超级×10 + 结果条数 1000 + 359 人 Box」时
      // **活堆只有 ~580MB，但分配太快、增量标记追不上** ⇒ 4.07GB 处直接 SIGABRT。
      // 给到 6GB 同样的输入 139s 跑完（结果 10.920）。真更大的形状仍然会崩 —— 那是下面的错误文案负责说清楚。
      resourceLimits: { maxOldGenerationSizeMb: 6144 },
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
      // 内存耗尽：V8 是先 abort 再抛 ERR_WORKER_OUT_OF_MEMORY，两者都给一句人话
      const message = String((err && err.message) || err);
      if (/out of memory|heap limit|ERR_WORKER_OUT_OF_MEMORY|assembly failure/i.test(message)) {
        this._finish(new Error("计算规模超出内存：请把「结果条数」调小，或把超级模式档位降一档"));
        return;
      }
      this._finish(err);
    });

    worker.on("exit", (code) => {
      // 正常路径已经 settled（result/error 消息先到）；这里只兜"没回消息就退出"
      if (this._settled) return;
      if (code === 0) {
        this._finish(new Error("计算引擎没有返回输出"));
      } else {
        const tail = this._stderrTail.trim();
        // 非 0 退出且没有引擎自己的输出 ⇒ 多半是 V8 内存耗尽被 abort（拿不到 message）
        const hint = "计算规模超出内存：请把「结果条数」调小，或把超级模式档位降一档";
        this._finish(new Error(tail || hint));
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
