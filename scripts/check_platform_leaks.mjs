#!/usr/bin/env node
/**
 * 平台泄漏检查（全平台化 · 阶段 0 产物）
 *
 * 目的：盯住「共用区不许直接碰系统能力」这条规矩。
 * 扫描范围：
 *   shared/              —— 公用区（跨平台共用代码，含将来搬进来的界面）
 *   renderer/            —— 当前共用界面（阶段 2 在这里改，阶段 4 搬进 shared/ui/）
 *   python-engine/engine/ —— 计算引擎核心（要能搬进浏览器 WASM）
 *
 * 用法：
 *   node scripts/check_platform_leaks.mjs            # 报告；有「错误级」则退出码 1
 *   node scripts/check_platform_leaks.mjs --verbose  # 同时列出扫描到的文件
 *   node scripts/check_platform_leaks.mjs --warn-as-error   # 警告也算失败（将来进 CI 用）
 *   node scripts/check_platform_leaks.mjs --json     # 机器可读输出
 *
 * 误报豁免：某一行结尾加注释 `platform-ok`（该行跳过检查）
 *   const x = require("electron"); // platform-ok 说明原因
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const args = new Set(process.argv.slice(2));
const WARN_AS_ERROR = args.has("--warn-as-error");
const AS_JSON = args.has("--json");
const VERBOSE = args.has("--verbose");

const TARGETS = [
  {
    dir: "shared",
    label: "公用区",
    lang: "js",
    exts: [".js", ".mjs", ".cjs", ".ts", ".vue", ".html", ".css"],
  },
  {
    dir: "renderer",
    label: "共用界面",
    lang: "js",
    exts: [".js", ".mjs", ".cjs", ".ts", ".vue", ".html", ".css"],
  },
  {
    dir: "python-engine/engine",
    label: "计算引擎",
    lang: "py",
    exts: [".py"],
  },
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  "build",
  ".idea",
  ".vscode",
]);

const SKIP_SUFFIX = [".min.js", ".bundle.js"];
const ALLOW_MARK = "platform-ok";

/** level: error = 必须修；warn = 可以先放着，属于「该走适配器」的提醒 */
const RULES = [
  // ---------- JS / 前端 ----------
  {
    lang: "js",
    level: "error",
    name: "Electron 依赖",
    re: /require\(\s*['"]electron['"]\s*\)|from\s+['"]electron['"]/,
    hint: "共用区不许直接依赖 Electron；需要平台能力就走 window.fgo.* 桥接。",
  },
  {
    lang: "js",
    level: "error",
    name: "Electron 桥接 API",
    re: /\b(contextBridge|ipcRenderer|ipcMain)\b/,
    hint: "桥接实现只允许出现在平台层（preload.js / platforms/*）。",
  },
  {
    lang: "js",
    level: "error",
    name: "Electron 窗口 / 系统 API",
    re: /\b(BrowserWindow|Menu\.buildFromTemplate|dialog\.[a-zA-Z]+\(|shell\.openExternal|app\.getPath)\b/,
    hint: "系统菜单、对话框、窗口是平台专属能力，交给平台层。",
  },
  {
    lang: "js",
    level: "error",
    name: "Node 文件系统",
    re: /require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)|from\s+['"](node:)?fs(\/promises)?['"]/,
    hint: "读写硬盘是平台能力；共用区通过 shared/storage/ 接口拿数据。",
  },
  {
    lang: "js",
    level: "error",
    name: "Node 路径",
    re: /require\(\s*['"](node:)?path['"]\s*\)|from\s+['"](node:)?path['"]/,
    hint: "路径拼接属平台细节，不要在共用区出现。",
  },
  {
    lang: "js",
    level: "error",
    name: "子进程",
    re: /require\(\s*['"](node:)?child_process['"]\s*\)|child_process|\.spawn\(|\.execFileSync\(/,
    hint: "起进程是平台能力（桌面起引擎、网页用 Worker）；走 shared/engine/ 接口。",
  },
  {
    lang: "js",
    level: "error",
    name: "原生 SQLite 绑定",
    re: /better-sqlite3|node:sqlite/,
    hint: "数据库连接只能出现在平台层实现里。",
  },
  {
    lang: "js",
    level: "error",
    name: "Node / Electron 运行时全局",
    re: /\bprocess\.(env|platform|argv|execPath|versions)\b|\bmodule\.exports\b/,
    hint: "共用区按浏览器环境写（ESM 导出）；平台差异用能力接口表达。",
  },
  {
    lang: "js",
    level: "error",
    name: "路径假设",
    re: /\b__dirname\b|\b__filename\b/,
    hint: "共用区不许假设自己是个文件；资源位置由平台层提供。",
  },
  {
    lang: "js",
    level: "error",
    name: "绕过桥接",
    re: /window\.(electron|require|api|Nodejs|ipc)\b/,
    hint: "界面与宿主的唯一通道是 window.fgo.*。",
  },
  {
    lang: "js",
    level: "error",
    name: "CommonJS require",
    re: /\brequire\s*\(/,
    hint: "共用区用 ESM（import）；CJS 只属于平台层。",
  },
  {
    lang: "js",
    level: "warn",
    name: "浏览器本地存储（应走适配器）",
    re: /\b(localStorage|sessionStorage|indexedDB)\b/,
    hint: "能跑但会被平台差异坑（file:// 下受限、桌面与浏览器数据不通）；阶段 1 收进 shared/storage/。",
  },
  {
    lang: "js",
    level: "warn",
    name: "界面内直连网络",
    re: /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\s*\(/,
    hint: "本产品全本地、不上传；确需联网（如数据更新）应走平台能力而非界面直连。",
  },
  {
    lang: "js",
    level: "warn",
    name: "剪贴板直连",
    re: /navigator\.clipboard/,
    hint: "桌面与浏览器的剪贴板权限模型不同，统一走 fgo.copyText（平台实现内自带降级）。",
  },
  {
    lang: "js",
    level: "warn",
    name: "打开新窗口",
    re: /\bwindow\.open\s*\(/,
    hint: "桌面用 shell.openExternal，安卓用系统浏览器；走平台能力。",
  },

  // ---------- Python / 引擎 ----------
  {
    lang: "py",
    level: "error",
    name: "PyInstaller 打包假设",
    re: /sys\._MEIPASS|pyinstaller/i,
    hint: "引擎核心要能在浏览器 WASM 里跑，不许依赖打包器行为。",
  },
  {
    lang: "py",
    level: "error",
    name: "子进程",
    re: /^\s*(import|from)\s+subprocess\b|\bsubprocess\./m,
    hint: "引擎不许自己起进程。",
  },
  {
    lang: "py",
    level: "error",
    name: "系统命令",
    re: /os\.system\s*\(|os\.popen\s*\(/,
    hint: "引擎不许调系统命令。",
  },
  {
    lang: "py",
    level: "error",
    name: "Windows 专属 API",
    re: /\bwinreg\b|\bwin32com\b|ctypes\.windll/,
    hint: "Windows 专属能力不能进引擎核心。",
  },
  {
    lang: "py",
    level: "error",
    name: "解释器路径假设",
    re: /sys\.executable/,
    hint: "WASM 环境下没有 sys.executable。",
  },
  {
    lang: "py",
    level: "error",
    name: "桌面 GUI / 浏览器库",
    re: /\btkinter\b|\bpyautogui\b|\bwebbrowser\b/,
    hint: "引擎是纯计算进程，不许带界面。",
  },
  {
    lang: "py",
    level: "warn",
    name: "引擎内直连网络",
    re: /\burllib\b|\brequests\b|\bsocket\b|http\.client/,
    hint: "只在数据更新时联网（data_fetcher.py，平台专属）；核心计算路径不许联网。",
  },
  {
    lang: "py",
    level: "warn",
    name: "直接写文件",
    re: /open\s*\(\s*['"][^'"]+['"]\s*,\s*['"][wax]/,
    hint: "写盘要走存储接口；WASM 下只有虚拟文件系统。",
  },
];

/** 纯注释行不算泄漏（注释里提到 Electron / urllib 是文档说明，不是依赖） */
function isCommentLine(line, lang) {
  const text = line.trim();
  if (!text) return true;
  if (lang === "py") return text.startsWith("#");
  return (
    text.startsWith("//") ||
    text.startsWith("/*") ||
    text.startsWith("*") ||
    text.startsWith("<!--")
  );
}

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, exts, out);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (!exts.includes(extname(lower))) continue;
      if (SKIP_SUFFIX.some((suffix) => lower.endsWith(suffix))) continue;
      out.push(full);
    }
  }
  return out;
}

const findings = [];
const scanReport = [];

for (const target of TARGETS) {
  const absDir = join(ROOT, target.dir);
  const exists = existsSync(absDir);
  const files = walk(absDir, target.exts);
  scanReport.push({ dir: target.dir, label: target.label, files: files.length, exists });

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARK)) return;
      if (isCommentLine(line, target.lang)) return;
      const rule = RULES.find((r) => r.lang === target.lang && r.re.test(line));
      if (!rule) return;
      findings.push({
        level: rule.level,
        rule: rule.name,
        hint: rule.hint,
        file: file.slice(ROOT.length).split("\\").join("/"),
        line: index + 1,
        text: line.trim().slice(0, 140),
      });
    });
  }
}

const errors = findings.filter((f) => f.level === "error");
const warnings = findings.filter((f) => f.level === "warn");
const failed = errors.length > 0 || (WARN_AS_ERROR && warnings.length > 0);

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        status: failed ? "fail" : "pass",
        scanned: scanReport,
        errors,
        warnings,
        counts: { errors: errors.length, warnings: warnings.length },
      },
      null,
      2
    )
  );
  process.exit(failed ? 1 : 0);
}

const pad = (s, n) => String(s).padEnd(n, " ");

console.log("平台泄漏检查 · 共用区不许直接碰系统能力");
console.log("");
console.log("扫描范围：");
for (const item of scanReport) {
  const note = item.exists ? `${item.files} 个文件` : "目录不存在，跳过";
  console.log(`  ${pad(item.dir + "/", 26)} ${note}`);
}
if (VERBOSE) {
  for (const item of scanReport) {
    const files = walk(join(ROOT, item.dir), TARGETS.find((t) => t.dir === item.dir).exts);
    for (const f of files) console.log(`      ${f.slice(ROOT.length).split("\\").join("/")}`);
  }
}
console.log("");

function printGroup(title, list) {
  console.log(`${title} ${list.length} 处`);
  const groups = new Map();
  for (const item of list) {
    if (!groups.has(item.rule)) groups.set(item.rule, []);
    groups.get(item.rule).push(item);
  }
  const MAX_SHOWN = 5;
  for (const [rule, items] of groups) {
    console.log(`  【${rule}】${items.length} 处`);
    for (const item of items.slice(0, MAX_SHOWN)) {
      console.log(`      ${item.file}:${item.line}`);
      console.log(`        ${item.text}`);
    }
    if (items.length > MAX_SHOWN) {
      const files = [...new Set(items.map((i) => i.file))].join(", ");
      console.log(`      …还有 ${items.length - MAX_SHOWN} 处（都在 ${files}）`);
    }
    console.log(`      → ${items[0].hint}`);
  }
  console.log("");
}

if (errors.length) printGroup("✗ 错误", errors);
if (warnings.length) printGroup("⚠ 警告（可以先放着，阶段 1 / 4 处理）", warnings);
if (!findings.length) console.log("✅ 没有发现问题。\n");

console.log(
  failed
    ? errors.length
      ? `结论：失败 —— ${errors.length} 处错误必须修掉。`
      : `结论：失败 —— 有 ${warnings.length} 处警告（--warn-as-error 模式）。`
    : `结论：通过${warnings.length ? `（${warnings.length} 处警告待处理）` : ""}。`
);
console.log("豁免方式：在对应行尾加注释 platform-ok（并写清原因）。");

process.exit(failed ? 1 : 0);
