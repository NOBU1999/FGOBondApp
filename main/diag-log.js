"use strict";

/**
 * 本地诊断日志（只写在本机，不上传任何地方）
 *
 * 写到「运行库目录\backup\renderer-日期.log」，内容包括：
 * - 渲染进程无响应 / 崩溃、GPU 与子进程异常退出（main/index.js）
 * - 主进程未捕获异常 / 未处理的 Promise 拒绝（main/index.js）
 * - Python 引擎失败时的错误信息与输出尾部（main/ipc-handlers.js）
 * - 运行时补齐缺失头像的结果（main/avatars.js）
 *
 * 文件名沿用 `renderer-日期.log`（最初就是这个名字，《使用说明》也照此说明），
 * 内容如今已不止渲染进程，但改名会让老用户按说明找不到文件，故保持不变。
 */

const fs = require("fs");
const path = require("path");
const { getDbPath } = require("./paths");

const LOG_PREFIX = "renderer";

let logFile = null;

/** 日志文件路径（首次调用时确定当天文件名；失败也不抛错） */
function diagLogPath() {
  if (!logFile) {
    const dir = path.join(path.dirname(getDbPath()), "backup");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      // ignore：目录建不出来时下面的写入会失败，由 diagLog 兜住
    }
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    logFile = path.join(dir, `${LOG_PREFIX}-${day}.log`);
  }
  return logFile;
}

/**
 * 记一条诊断日志。绝不抛错：诊断本身不能把程序弄挂。
 * 多行文本（例如引擎输出尾部）会原样写入。
 */
function diagLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    console.log(`[diag] ${message}`);
  } catch (_) {
    // ignore
  }
  try {
    fs.appendFileSync(diagLogPath(), line + "\n", "utf8");
  } catch (_) {
    // ignore
  }
}

/** 把长文本裁成末尾 limit 个字符（引擎输出可能很长，只留尾巴） */
function tailOf(text, limit = 3000) {
  const s = String(text == null ? "" : text);
  const t = s.trim();
  return t.length > limit ? `…${t.slice(-limit)}` : t;
}

/**
 * 读回诊断日志（供界面「诊断日志」面板显示 / 复制）。
 * 只读末尾 maxBytes 字节，避免日志大了把界面卡住；不抛错。
 */
function readDiagLog(maxBytes = 200 * 1024) {
  const file = diagLogPath();
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return { ok: true, path: file, text: buf.toString("utf8"), truncated: start > 0, size: stat.size };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return { ok: true, path: file, text: "", truncated: false, size: 0 };
  }
}

/** 清空诊断日志（清之前先把文件删掉，下次写入会重新创建）；不抛错 */
function clearDiagLog() {
  const file = diagLogPath();
  try {
    fs.rmSync(file, { force: true });
    return { ok: true, path: file };
  } catch (_) {
    return { ok: false, path: file };
  }
}

module.exports = { diagLog, diagLogPath, tailOf, readDiagLog, clearDiagLog };
