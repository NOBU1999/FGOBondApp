"use strict";

/**
 * 引擎「独立子进程」外壳（v0.3.8 第 2 项）
 *
 * 与 `engine-ts-worker.js`（worker_threads）**同一套对外接口**：
 *   calculate / check / update / stop / stderrTail，以及 `progress` / `error` 事件。
 *
 * 差别只在隔离级别：worker_threads 与主进程共享 V8 堆上限与进程，极端规模下 OOM
 * 会连界面一起带走；独立子进程里引擎崩了主界面还在，用户能重试。
 * 一次计算起一个进程，回完结果就退出 —— 内存与 WASM 实例彻底归还。
 *
 * 由「设置 → 高级 → 计算引擎独立运行」打开（默认关，需重启生效）。
 */
const { EventEmitter } = require("events");
const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getAppRoot } = require("./paths");

class EngineChildProcess extends EventEmitter {
  constructor({ dbPath } = {}) {
    super();
    this.dbPath = dbPath;
    this.child = null;
    this._stderrTail = "";
    this._settled = false;
    this._resolve = null;
  }

  get stderrTail() {
    return this._stderrTail.trim();
  }

  _bundlePath() {
    return path.join(getAppRoot(), "dist", "engine-ts", "child.mjs");
  }

  _appendLog(line) {
    this._stderrTail = (this._stderrTail + line).slice(-8192);
  }

  _finish(err, payload) {
    if (this._settled) return;
    this._settled = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
    }
    if (this._resolve) this._resolve(err, payload);
  }

  run(mode, payload) {
    return new Promise((resolve, reject) => {
      if (this.child) {
        reject(new Error("计算引擎已经在运行"));
        return;
      }
      const script = this._bundlePath();
      if (!fs.existsSync(script)) {
        reject(
          new Error(
            `未找到子进程引擎产物 ${script}，请重新安装程序（或运行 npm run build:engine-ts）`,
          ),
        );
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
      this._settled = false;
      this._stderrTail = "";

      let child;
      try {
        child = fork(script, [], {
          // Electron 里 fork 出来的子进程必须按 Node 跑（不启动 Chromium）
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
      } catch (err) {
        this._settled = true;
        this._resolve = null;
        reject(err);
        return;
      }
      this.child = child;

      child.stderr.on("data", (chunk) => this._appendLog(String(chunk)));
      child.stdout.on("data", (chunk) => this._appendLog(String(chunk)));

      child.on("message", (msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "progress") {
          const line = String(msg.line || "").trim();
          if (line) {
            this._appendLog(line + "\n");
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

      child.on("error", (err) => {
        this._appendLog(String((err && err.stack) || err));
        const message = String((err && err.message) || err);
        if (/out of memory|heap limit|ERR_WORKER_OUT_OF_MEMORY|assembly failure/i.test(message)) {
          this._finish(new Error("计算规模超出内存：请把「结果条数」调小，或把超级模式档位降一档"));
          return;
        }
        this._finish(err);
      });

      child.on("exit", (code) => {
        if (this._settled) return;
        const tail = this._stderrTail.trim();
        if (code === 0) {
          this._finish(new Error("计算引擎没有返回输出"));
        } else {
          this._finish(
            new Error(tail || "计算规模超出内存：请把「结果条数」调小，或把超级模式档位降一档"),
          );
        }
      });

      // 子进程起来后立刻把这次任务发过去（IPC 未就绪时 fork 会排队）
      try {
        child.send({
          type: "job",
          job: {
            appRoot: getAppRoot(),
            dbPath: this.dbPath,
            mode,
            payload: payload === undefined ? null : payload,
          },
        });
      } catch (err) {
        this._finish(err);
      }
    });
  }

  calculate(payload) {
    return this.run("calculate", payload);
  }

  check() {
    return this.run("check");
  }

  update() {
    return this.run("update");
  }

  stop() {
    const child = this.child;
    if (!child) return;
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
    // 与 worker 版一致：把 pending 的 Promise 结掉，调用方不会一直 await
    this._finish(new Error("已停止计算"));
  }
}

module.exports = { EngineChildProcess };
