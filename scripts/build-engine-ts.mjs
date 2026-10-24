// 打包引擎（P4b）：把 engine-ts 打成 bundle，并把 sql.js 的 wasm 复制到产物旁边。
//   node scripts/build-engine-ts.mjs          → dist/engine-ts/worker.mjs（桌面 worker_threads）
//   node scripts/build-engine-ts.mjs --web    → dist/engine-ts/web.mjs（ESM，冒烟/将来 PWA）
//                                             + dist/engine-ts/web.js（IIFE，安卓 WebView 的 classic worker）
//
// ⚠️ 桌面 bundle **不把 sql.js 标 external**：发布包的 app.asar 里没有 node_modules，
//    所以 sql.js 的 JS 被打进 bundle，wasm 单独复制（运行时按 wasmBinary 读进去）。
// ⚠️ 安卓为什么要 IIFE：Worker 里要 `importScripts(".../sql-wasm.js")` 才能拿到 `initSqlJs`，
//    而 `importScripts` **只有 classic worker 有**（module worker 里没有）⇒ 不能只有 ESM 版。
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireHere = createRequire(path.join(ROOT, "package.json"));
const esbuild = requireHere("esbuild");

const web = process.argv.includes("--web");
const outDir = path.join(ROOT, "dist", "engine-ts");
fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();

async function build({ entry, outfile, platform, target, format, globalName }) {
  await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format,
    globalName,
    platform,
    target,
    outfile,
    // sql.js 保持 external：它的 JS 里有动态 require，打进 ESM bundle 会炸；
    // 改为把 sql-wasm.js / .wasm 复制到产物旁边，运行时按绝对路径 require。
    external: ["sql.js"],
    logLevel: "warning",
    sourcemap: false,
  });
  const kb = Math.round(fs.statSync(outfile).size / 1024);
  console.log(`[engine-ts] ${path.relative(ROOT, outfile)}（${kb}KB）`);
}

if (web) {
  // ① ESM（P4a 冒烟用：browser 目标 + platformWeb，有 node: 导入会直接失败）
  await build({
    entry: "engine-ts/entry/web.ts",
    outfile: path.join(outDir, "web.mjs"),
    platform: "browser",
    target: "es2022",
    format: "esm",
  });
  // ② IIFE（安卓 classic worker 用：先 importScripts 拿 sql.js，再 importScripts 这份）
  await build({
    entry: "engine-ts/entry/web.ts",
    outfile: path.join(outDir, "web.js"),
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "FgoEngine",
  });
} else {
  await build({
    entry: "engine-ts/entry/worker.ts",
    outfile: path.join(outDir, "worker.mjs"),
    platform: "node",
    target: "node22",
    format: "esm",
  });
  // sql.js 的 JS + wasm 跟 bundle 放一起（platformNode 第一顺位就是这里）
  for (const name of ["sql-wasm.js", "sql-wasm.wasm"]) {
    const src = requireHere.resolve(`sql.js/dist/${name}`);
    const dst = path.join(outDir, name);
    fs.copyFileSync(src, dst);
    console.log(`[engine-ts] ${name} → ${path.relative(ROOT, dst)}（${Math.round(fs.statSync(dst).size / 1024)}KB）`);
  }
}

console.log(`[engine-ts] 完成（${((Date.now() - t0) / 1000).toFixed(2)}s）`);
