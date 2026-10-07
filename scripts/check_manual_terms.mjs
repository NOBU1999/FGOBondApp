// 手册自检：使用说明.txt 里用「」引用的界面词，在界面代码里是否真的存在。
//
// 为什么要它：手册是给用户的，界面一改（按钮改名、入口搬家）手册就会说谎，
// 而这类错误只有用户看手册时才会发现（2026-10-07 用户实测抓到："更新数据"那一节
// 写的按钮名是旧的「检查并更新 / 强制更新」，界面上其实是「检查刷新 / 更新数据」）。
//
// 用法：node scripts/check_manual_terms.mjs        # 只报告，退出码始终 0
//       node scripts/check_manual_terms.mjs --strict  # 有对不上的就退出码 1
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

// 扫描范围：界面会出现的文案都在这些文件里
const UI_FILES = [
  "renderer/app.js",
  "renderer/index.html",
  "preload.js",
  "main/menu.js",
  "main/index.js",
  "shared/domain/accounts.mjs",
];

let ui = "";
for (const rel of UI_FILES) {
  const p = path.join(ROOT, rel);
  if (existsSync(p)) ui += readFileSync(p, "utf8");
}
const uiFlat = ui.replace(/\s+/g, "");

const manual = readFileSync(path.join(ROOT, "使用说明.txt"), "utf8");
const COMPOUND = [" / ", "→", "（N）"];
const FILE_LIKE = /\.[a-z]{2,4}$/i; // updater.exe / fgo_data.db 之类是文件名，不是界面文案
const terms = new Map();
manual.split("\n").forEach((line, idx) => {
  for (const m of line.matchAll(/「([^「」]{1,24})」/g)) {
    const t = m[1].trim();
    if (t && !terms.has(t)) terms.set(t, idx + 1);
  }
});

const miss = [];
for (const [t, ln] of terms) {
  if (COMPOUND.some((c) => t.includes(c))) continue; // 组合描述（"读取 / 复制全部 / 清空"）
  if (FILE_LIKE.test(t)) continue; // 文件名
  const key = t.replace(/[.…]+$/, "");
  if (!key) continue;
  if (ui.includes(key) || uiFlat.includes(key.replace(/\s+/g, ""))) continue;
  miss.push([ln, t]);
}

if (!miss.length) {
  console.log(`[manual] ✅ 手册引用的界面词都能在界面代码里找到（共查 ${terms.size} 个）`);
} else {
  console.warn(`[manual] ⚠️ 有 ${miss.length} 个「」引用在界面代码里找不到（可能已改名/删掉）：`);
  for (const [ln, t] of miss.sort((a, b) => a[0] - b[0])) {
    console.warn(`        使用说明.txt 第 ${ln} 行：「${t}」`);
  }
  console.warn("        → 请核对界面实际文案；确认是动态文案/概念词可忽略");
  if (STRICT) process.exit(1);
}
