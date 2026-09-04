"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { getEngineLaunchInfo } = require("./paths");

/**
 * Python 计算引擎子进程管理器。
 *
 * 通信：
 * - stdin：请求 JSON
 * - stdout：结果 JSON
 * - stderr：进度/日志文本（以 [progress] 开头）
 */
class PythonProcess extends EventEmitter {
  constructor({ dbPath } = {}) {
    super();
    this.dbPath = dbPath;
    this.child = null;
    this._stdout = "";
    this._stderrTail = "";
  }

  _launchArgs(mode, forceUpdate = false) {
    const base = ["--mode", mode, "--db", this.dbPath];
    if (mode === "update" && forceUpdate) {
      base.push("--force-update");
    }
    return base;
  }

  _spawn(mode, forceUpdate = false) {
    if (this.child) {
      throw new Error("Python 引擎已经在运行");
    }
    const info = getEngineLaunchInfo();
    const args = this._launchArgs(mode, forceUpdate);
    const childEnv = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    };
    let child;
    if (info.type === "python") {
      child = spawn("python", [info.path, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: false,
        env: childEnv,
      });
    } else {
      child = spawn(info.path, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: false,
        env: childEnv,
      });
    }
    this.child = child;
    this._stdout = "";
    this._stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      this._stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-8192);
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text) this.emit("progress", text);
      }
    });

    child.on("error", (err) => {
      this.emit("error", err);
    });
  }

  _parseResult() {
    const text = this._stdout.trim();
    if (!text) {
      const tail = this._stderrTail.trim();
      throw new Error(tail || "Python 引擎没有返回输出");
    }
    // 引擎只输出一个 JSON 对象；若混有非 JSON 日志，取最后一个完整对象
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch (_) {
        // ignore non-JSON lines
      }
    }
    throw new Error("Python 引擎返回了无法解析的 JSON");
  }

  run(mode, payload = undefined, forceUpdate = false) {
    return new Promise((resolve, reject) => {
      if (this.child) {
        reject(new Error("Python 引擎已经在运行"));
        return;
      }
      try {
        this._spawn(mode, forceUpdate);
      } catch (err) {
        reject(err);
        return;
      }

      const child = this.child;
      let settled = false;

      const cleanup = () => {
        if (child.stdout) child.stdout.removeAllListeners("data");
        if (child.stderr) child.stderr.removeAllListeners("data");
        child.removeAllListeners("error");
        child.removeAllListeners("close");
        child.removeAllListeners("exit");
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.child = null;
        try {
          const result = this._parseResult();
          if (result && result.status === "error") {
            reject(new Error(result.message || "计算失败"));
          } else {
            resolve(result);
          }
        } catch (err) {
          reject(err);
        }
      });

      child.on("exit", (code) => {
        // close 后处理；这里仅用于提前标记非零退出
        if (settled) return;
        if (code !== 0 && !this._stdout.trim()) {
          settled = true;
          cleanup();
          this.child = null;
          reject(new Error(this._stderrTail.trim() || `Python 引擎退出码 ${code}`));
        }
      });

      if (payload !== undefined) {
        child.stdin.write(JSON.stringify(payload));
      }
      child.stdin.end();
    });
  }

  calculate(payload) {
    return this.run("calculate", payload, false);
  }

  update(force = false) {
    return this.run("update", undefined, force);
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch (_) {
        // ignore
      }
      this.child = null;
    }
  }
}

module.exports = { PythonProcess };
