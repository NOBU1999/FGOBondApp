// 把 使用说明.txt 生成成 renderer/manual.js（应用内「使用说明」面板的内容来源）
//
// 为什么这么做：
//   - 手册只有一份来源（使用说明.txt，便携包里也会照旧带一份给想存文件的用户）；
//   - 界面要显示它，但渲染层没有文件系统权限 → 打包前由本脚本生成成 JS 常量；
//   - 出包脚本（build_all.mjs）会自动跑这一步，避免两边不同步。
//
// 用法：node scripts/make_manual_js.mjs [--check]
//   --check：只校验 renderer/manual.js 是否已是最新（不一致则退出码 1，供 CI/自检用）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "使用说明.txt");
const DST = path.join(ROOT, "renderer", "manual.js");
const CHECK = process.argv.includes("--check");

const text = readFileSync(SRC, "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n";
const escaped = text
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const banner =
  "// ⚠️ 本文件由 scripts/make_manual_js.mjs 从 使用说明.txt 自动生成 —— 请勿手改。\n" +
  "// 改内容请改 使用说明.txt，然后跑：node scripts/make_manual_js.mjs\n";
const out = `${banner}window.FGO_MANUAL_TEXT = \`${escaped}\`;\n`;

if (CHECK) {
  const cur = existsSync(DST) ? readFileSync(DST, "utf8") : "";
  if (cur !== out) {
    console.error("[manual] ❌ renderer/manual.js 与 使用说明.txt 不一致 → 跑 node scripts/make_manual_js.mjs");
    process.exit(1);
  }
  console.log("[manual] ✅ renderer/manual.js 与 使用说明.txt 一致");
} else {
  writeFileSync(DST, out, "utf8");
  console.log(`[manual] 使用说明.txt（${text.length} 字符）→ renderer/manual.js`);
}
