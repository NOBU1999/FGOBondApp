// 手册自检：使用说明.txt 里用「」引用的界面词，在界面代码里是否真的存在。
//
// 为什么要它：手册是给用户的，界面一改（按钮改名、入口搬家）手册就会说谎，
// 而这类错误只有用户看手册时才会发现（2026-10-07 用户实测抓到："更新数据"那一节
// 写的按钮名是旧的「检查并更新 / 强制更新」，界面上其实是「检查刷新 / 更新数据」）。
//
// 用法：node scripts/check_manual_terms.mjs        # 只报告，退出码始终 0
//       node scripts/check_manual_terms.mjs --strict  # 有对不上的就退出码 1
//
// 比对分三档（2026-10-24 加的两档，之前只看"原文里有没有"）：
//   ① 原文出现  → 直接过；
//   ② 宽松出现  → 把模板插值 `{{…}}`、引号「」""''、小括号说明（复现）/（完整）都当噪声再比一次
//                （手册写的是**玩家看到的样子**，而代码里那几处是动态文案）；
//   ③ 概念词白名单 → 游戏内名词或行为描述，本来就不该出现在界面代码里（下面 CONCEPT_TERMS）。
// 三档都不过才是真的"手册与界面对不上"。
//
// ⚠️ 宽松档的代价：像「复制验证串（复现）→（完整）」这种**括号内容变了**也照样算过。
//    这一档只管"按钮还在不在"，不管"括号里是不是同一个模式"。
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

/** 游戏内名词 / 行为描述：手册里用「」只是为了强调，不是界面文案 */
const CONCEPT_TERMS = new Map([
  ["梦火的引导", "游戏职阶技能名（FGO 官方术语）"],
  ["实际持有", "行为描述（导入只算真正持有的从者），不是按钮或字段名"],
]);

/** 复合描述：这几处是"把两个界面元素合起来说"，拆开逐个查 */
const SPLIT_RE = /[+＋]|\s\/\s|→/;

const FILE_LIKE = /\.[a-z]{2,4}$/i; // fgo_data.db 之类是文件名，不是界面文案

let ui = "";
for (const rel of UI_FILES) {
  const p = path.join(ROOT, rel);
  if (existsSync(p)) ui += readFileSync(p, "utf8");
}
const flat = (s) => s.replace(/\s+/g, "");
const uiExact = flat(ui);
const uiLenient = flat(ui)
  .replace(/\{\{[^}]*\}\}/g, "") // 模板插值：玩家看到的是具体内容
  .replace(/[「」『』“”"']/g, "")
  .replace(/（[^（）]{0,24}）/g, "")
  .replace(/\([^()]{0,24}\)/g, "");

const manual = readFileSync(path.join(ROOT, "使用说明.txt"), "utf8");
const terms = new Map();
manual.split("\n").forEach((line, idx) => {
  for (const m of line.matchAll(/「([^「」]{1,24})」/g)) {
    const t = m[1].trim();
    if (t && !terms.has(t)) terms.set(t, idx + 1);
  }
});

const lenientHits = [];
const concepts = [];
const miss = [];

function hitExact(text) {
  const key = text.replace(/[.…]+$/, "");
  if (!key) return true;
  return uiExact.includes(flat(key));
}
function hitLenient(text) {
  const key = flat(text)
    .replace(/[「」『』“”"']/g, "")
    .replace(/（[^（）]{0,24}）/g, "")
    .replace(/\([^()]{0,24}\)/g, "") // 手册那侧的括号说明同样当噪声
    .replace(/[.…]+$/, "");
  if (!key) return true;
  return uiLenient.includes(key);
}

for (const [t, ln] of terms) {
  if (FILE_LIKE.test(t)) continue;
  if (CONCEPT_TERMS.has(t)) {
    concepts.push([ln, t]);
    continue;
  }
  const parts = t.split(SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  let okExact = true;
  let okLenient = true;
  for (const part of parts) {
    if (!hitExact(part)) okExact = false;
    if (!hitLenient(part)) okLenient = false;
  }
  if (okExact) continue;
  if (okLenient) {
    lenientHits.push([ln, t]);
    continue;
  }
  miss.push([ln, t]);
}

console.log(
  `[manual] 共查 ${terms.size} 个「」引用：原文命中 ${terms.size - lenientHits.length - concepts.length - miss.length}` +
    `｜宽松命中 ${lenientHits.length}｜概念词 ${concepts.length}｜对不上 ${miss.length}`,
);
for (const [ln, t] of lenientHits) {
  console.log(`         · 第 ${ln} 行「${t}」（界面里是动态文案，按宽松口径算存在）`);
}
for (const [ln, t] of concepts) {
  console.log(`         · 第 ${ln} 行「${t}」＝${CONCEPT_TERMS.get(t)}`);
}

if (!miss.length) {
  console.log("[manual] ✅ 手册引用的界面词都对得上");
} else {
  console.warn(`[manual] ⚠️ 有 ${miss.length} 个「」引用在界面代码里找不到（可能已改名/删掉）：`);
  for (const [ln, t] of miss.sort((a, b) => a[0] - b[0])) {
    console.warn(`        使用说明.txt 第 ${ln} 行：「${t}」`);
  }
  console.warn("        → 请核对界面实际文案；确认是动态文案/概念词可加进 CONCEPT_TERMS（写上原因）");
  if (STRICT) process.exit(1);
}
