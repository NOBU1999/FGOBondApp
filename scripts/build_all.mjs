#!/usr/bin/env node
"use strict";

/**
 * 一键出两个包：Windows 便携版 + 安卓 APK（阶段 6 产物）
 *
 * 用法：
 *   node scripts/build_all.mjs                      # 两个都出
 *   node scripts/build_all.mjs --skip-windows       # 只出 APK
 *   node scripts/build_all.mjs --skip-android       # 只出 Windows 包
 *   node scripts/build_all.mjs --force-engine       # 强制重跑 PyInstaller 重建 engine.exe
 *   node scripts/build_all.mjs --notes "本版更新内容…" --compatible-from 0.1.9
 *
 * 产物（都在 release/）：
 *   FGO牵绊推荐器-v<版本>-Android.apk     正式签名 APK（版本号取自 package.json）
 *   FGO牵绊推荐器-v<版本>.7z              Windows 便携版（7z）
 *   FGO牵绊推荐器-v<版本>.zip             Windows 便携版（zip，兼容用）
 *   release-manifest-v<版本>.json         两个包的体积与 SHA-256
 *   RELEASE_NOTES_v<版本>.md              发布说明（模板 + 校验值，你补上更新内容即可粘贴到 Release）
 *
 * 说明：
 *   - 版本号**唯一来源** = package.json（Windows 与安卓同一版本号；安卓 versionCode 由它换算）
 *   - Windows 侧沿用既有流程：electron-builder --win dir → make_release_meta.py → 7z 打包
 *   - 种子库：打包前跑 scripts/make_seed.cjs —— 由开发库**复制一份再清空用户表**，
 *     绝不直接用开发库当种子库（v0.1.11 真实事故：包里带上了开发者的账号 / Box / 队伍）
 *   - 发出前自检：scripts/verify_package.cjs 检查便携目录与压缩包（种子库无个人数据、
 *     无 node_modules 构建垃圾、语言包已精简）
 *   - 隐私检查：若本地存在 scripts/privacy_clean.py，打包前会跑 --check（发现个人数据即中止）
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const PRODUCT = PKG.productName || "app";
const NOTES = value("--notes", "");
const COMPAT_FROM = value("--compatible-from", null);
const SKIP_WINDOWS = has("--skip-windows");
const SKIP_ANDROID = has("--skip-android");
const FORCE_ENGINE = has("--force-engine");

const RELEASE_DIR = path.join(ROOT, "release");
const SEVEN_ZIP = "C:/Program Files/7-Zip/7z.exe";
const JAVA_HOME = "C:/Users/25679/AppData/Roaming/.minecraft/runtime/java-runtime-delta";
const ANDROID_HOME = "D:/Android/Sdk";
const GRADLE_USER_HOME = "D:/dsh-agent/.gradle-home";

const log = (...a) => console.log("[build]", ...a);
const step = (t) => console.log(`\n=== ${t} ===`);
const fatal = (msg) => {
  console.error("\n✗ " + msg);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  // Windows 上 .cmd / .bat 必须通过 shell 启动（Node 的安全限制：不允许直接 spawn 批处理）
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
  log("$ " + [cmd, ...cmdArgs].join(" "));
  execFileSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT, shell: needsShell, windowsHide: true, ...opts });
}

function npmRun(script) {
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script]);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fileInfo(file) {
  return { file: path.basename(file), bytes: statSync(file).size, sha256: sha256(file) };
}

function humanSize(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

mkdirSync(RELEASE_DIR, { recursive: true });
log(`版本 ${VERSION}｜产物目录 ${path.relative(ROOT, RELEASE_DIR)}`);

const artifacts = [];

// ---------------------------------------------------------------- 安卓 APK
function buildAndroid() {
  step("安卓 APK（Capacitor + Chaquopy，正式签名）");
  if (!existsSync(path.join(ROOT, "android", "keystore.properties"))) {
    fatal("缺少 android/keystore.properties（正式签名配置）→ 先跑：node scripts/android/create_keystore.cjs");
  }
  npmRun("android:sync");
  run(path.join(ROOT, "android", "gradlew.bat"), ["assembleRelease", "--no-daemon", "--console=plain"], {
    cwd: path.join(ROOT, "android"),
    env: {
      ...process.env,
      JAVA_HOME,
      ANDROID_HOME,
      GRADLE_USER_HOME,
      JAVA_TOOL_OPTIONS: "-Duser.language=en -Duser.country=US",
    },
  });

  const built = path.join(ROOT, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!existsSync(built)) fatal("没有产出 release APK：" + built);
  const dest = path.join(RELEASE_DIR, `${PRODUCT}-v${VERSION}-Android.apk`);
  copyFileSync(built, dest);
  log(`→ ${path.relative(ROOT, dest)}（${humanSize(statSync(dest).size)}）`);
  artifacts.push(fileInfo(dest));
  return dest;
}

// ---------------------------------------------------------------- Windows 便携版
function newestMtime(targets) {
  let newest = 0;
  const walk = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name === "__pycache__") continue;
        walk(path.join(p, entry.name));
      }
      return;
    }
    if (p.endsWith(".py")) newest = Math.max(newest, st.mtimeMs);
  };
  for (const t of targets) walk(t);
  return newest;
}

function buildWindows() {
  step("Windows 便携版");
  const engineExe = path.join(ROOT, "python-engine", "engine.exe");
  // 关键：engine.exe 是预编译产物（PyInstaller）。只要引擎源码比它新就必须重建，
  // 否则打出来的 Windows 包装的是旧引擎（实测踩过：解不了安卓版验证串）。
  const engineSrcNewest = newestMtime([
    path.join(ROOT, "python-engine", "engine"),
    path.join(ROOT, "python-engine", "engine_launcher.py"),
  ]);
  const exeTime = existsSync(engineExe) ? statSync(engineExe).mtimeMs : 0;
  const stale = !existsSync(engineExe) || engineSrcNewest > exeTime;
  if (FORCE_ENGINE || stale) {
    log(stale && existsSync(engineExe) ? "引擎源码比 engine.exe 新 → 自动重建引擎" : "重建引擎（PyInstaller）");
    // 引擎重建要 pip 装依赖：默认给国内镜像，避免卡在默认源（实测曾被中断反复重试十几分钟）
    const pipEnv = { ...process.env, PIP_INDEX_URL: process.env.PIP_INDEX_URL || "https://pypi.tuna.tsinghua.edu.cn/simple" };
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:engine"], { env: pipEnv });
  } else {
    log("engine.exe 已是最新（跳过 PyInstaller；要强制重建加 --force-engine）");
  }

  // 种子库：db/fgo_data.seed.db 是玩家首次运行时复制成运行库的模板，必须「复制一份再清空用户表」。
  // 不能像以前那样直接把开发机工作库 db/fgo_data.db 当种子库（v0.1.11 真实事故：
  // Windows 包里带上了开发者的 2 个账号 / 7 个从者 / 1 支队伍 / 4 条排除）。
  npmRun("make:seed");

  const electronBuilder = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
  // 离线/加速兜底：electron 二进制默认从网上下（国内直连 github 会超时，已在 package.json 里
  // 配了 npmmirror 镜像）。若本地已有下载好的 electron zip，可用环境变量直接指定，完全不联网：
  //   $env:FGO_ELECTRON_DIST = "$env:LOCALAPPDATA\electron\Cache\electron-v44.1.1-win32-x64.zip"
  const electronArgs = ["--win", "dir"];
  if (process.env.FGO_ELECTRON_DIST) {
    log(`使用本地 electron 发行包：${process.env.FGO_ELECTRON_DIST}`);
    electronArgs.push(`--config.electronDist=${process.env.FGO_ELECTRON_DIST}`);
  }
  run(electronBuilder, electronArgs);

  // electron-builder 的 dir 目标输出到 release/win-unpacked，
  // 而既有流程（make_release_meta / privacy_clean / fetch_missing_avatars / 更新器）都约定
  // 应用目录是 release/MyFGOApp → 这里改名到位。不这么做会打到上一次的旧目录里（实测踩过：
  // 会产出"标签新版本、内容却是旧版本"的错包）。
  const unpackedDir = path.join(RELEASE_DIR, "win-unpacked");
  const appDir = path.join(RELEASE_DIR, "MyFGOApp");
  if (!existsSync(unpackedDir)) fatal("electron-builder 没有产出 release/win-unpacked");
  rmSync(appDir, { recursive: true, force: true });
  renameSync(unpackedDir, appDir);
  log(`electron-builder 产物已改名到位：${path.relative(ROOT, unpackedDir)} → ${path.relative(ROOT, appDir)}`);
  if (!existsSync(appDir)) fatal("没有产出 release/MyFGOApp");

  // 打包完立刻自检：种子库是否干净、有没有混入 node_modules / 安卓构建垃圾、语言包是否精简
  run(process.execPath, ["scripts/verify_package.cjs", "--app-dir", appDir]);

  const metaArgs = ["scripts/make_release_meta.py", "--version", VERSION];
  if (COMPAT_FROM) metaArgs.push("--compatible-from", COMPAT_FROM);
  metaArgs.push("--notes", NOTES || `v${VERSION}`);
  run(process.platform === "win32" ? "python" : "python3", metaArgs);

  const privacyClean = path.join(ROOT, "scripts", "privacy_clean.py");
  if (existsSync(privacyClean)) {
    run(process.platform === "win32" ? "python" : "python3", ["scripts/privacy_clean.py", "--check"]);
  } else {
    log("（本地没有 privacy_clean.py，跳过隐私检查）");
  }

  if (!existsSync(SEVEN_ZIP)) fatal("找不到 7-Zip：" + SEVEN_ZIP);

  const sevenz = path.join(RELEASE_DIR, `${PRODUCT}-v${VERSION}.7z`);
  const zip = path.join(RELEASE_DIR, `${PRODUCT}-v${VERSION}.zip`);
  for (const f of [sevenz, zip]) rmSync(f, { force: true });

  // -mx=5：压缩时间约为极限压缩(-mx=9)的一半，体积只大 3~5%（实测 484MB 目录 ~2 分钟 vs ~4 分钟）
  const level = value("--level", "5");
  run(SEVEN_ZIP, ["a", "-t7z", `-mx=${level}`, sevenz, appDir]);
  log(`→ ${path.relative(ROOT, sevenz)}（${humanSize(statSync(sevenz).size)}）`);
  artifacts.push(fileInfo(sevenz));
  run(process.execPath, ["scripts/verify_package.cjs", "--archive", sevenz]);

  if (has("--with-zip")) {
    run(SEVEN_ZIP, ["a", "-tzip", `-mx=${level}`, zip, appDir]);
    log(`→ ${path.relative(ROOT, zip)}（${humanSize(statSync(zip).size)}）`);
    artifacts.push(fileInfo(zip));
    run(process.execPath, ["scripts/verify_package.cjs", "--archive", zip]);
  } else {
    log("（默认不出 zip；需要时加 --with-zip）");
  }
}

// ---------------------------------------------------------------- 清单 + 发布说明
function writeManifestAndNotes() {
  step("发布清单与说明");
  const builtAt = new Date().toISOString();
  const versionCode = (() => {
    const p = VERSION.split(".").map((x) => parseInt(x, 10) || 0);
    while (p.length < 3) p.push(0);
    return p[0] * 10000 + p[1] * 100 + p[2];
  })();

  // 合并已有清单：允许"分两次跑"（只出 APK / 只出 Windows）也能得到完整清单
  const manifestFile = path.join(RELEASE_DIR, `release-manifest-v${VERSION}.json`);
  let previous = [];
  try {
    const old = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (old && Array.isArray(old.artifacts)) previous = old.artifacts;
  } catch (_) {
    /* 首次生成 */
  }
  const merged = [...previous.filter((p) => !artifacts.some((a) => a.file === p.file)), ...artifacts];
  const manifest = {
    productName: PRODUCT,
    version: VERSION,
    androidVersionCode: versionCode,
    builtAt,
    artifacts: merged,
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  log(`→ ${path.relative(ROOT, manifestFile)}（含 ${merged.length} 个产物）`);

  const lines = [
    `# ${PRODUCT} v${VERSION}`,
    "",
    "> 本文件是发布说明模板：把「本版更新」补上，就可以直接粘贴到 GitHub / Gitee Release 与网盘说明里。",
    "",
    "## 本版更新",
    "",
    NOTES ? NOTES : "- （在这里写本版更新内容）",
    "",
    "## 下载",
    "",
    "| 平台 | 文件 | 大小 | SHA-256 |",
    "|---|---|---|---|",
  ];
  for (const a of merged) {
    const platform = a.file.includes("Android") ? "安卓 APK" : a.file.endsWith(".7z") ? "Windows 便携版（推荐）" : a.file.endsWith(".zip") ? "Windows 便携版（zip）" : "其他";
    lines.push(`| ${platform} | \`${a.file}\` | ${humanSize(a.bytes)} | \`${a.sha256}\` |`);
  }
  const isAndroid = merged.some((a) => a.file.includes("Android"));
  lines.push(
    "",
    "## 安装说明",
    ""
  );
  if (artifacts.some((a) => a.file.endsWith(".7z") || a.file.endsWith(".zip"))) {
    lines.push("**Windows**：解压后运行 `FGO牵绊推荐器.exe`。覆盖旧版本时请解压到**同一个文件夹**（数据自动保留）。");
  }
  if (isAndroid) {
    lines.push(
      "**安卓**：下载 APK → 允许「安装未知来源应用」→ 安装。",
      "覆盖安装同一签名的旧版本时**数据自动保留**；不要卸载后再装（会清空 Box/账号）。"
    );
  }
  lines.push(
    "",
    "## 隐私说明",
    "",
    "纯本地运行：不上传任何数据、无登录、无服务器。游戏数据随包发布，个人数据（账号 / Box / 排除名单 / 队伍）只存在你自己设备上。",
    "",
    "## 校验方式（可选）",
    "",
    "```",
    "# Windows (PowerShell)",
    "Get-FileHash .\\<文件名> -Algorithm SHA256",
    "# 安卓 APK（需要 Android SDK build-tools）",
    "apksigner verify --print-certs <文件名>.apk",
    "```",
    ""
  );
  const notesFile = path.join(RELEASE_DIR, `RELEASE_NOTES_v${VERSION}.md`);
  writeFileSync(notesFile, lines.join("\n"), "utf8");
  log(`→ ${path.relative(ROOT, notesFile)}`);
  return manifest;
}

// ---------------------------------------------------------------- 主流程
if (!SKIP_ANDROID) buildAndroid();
if (!SKIP_WINDOWS) buildWindows();
if (artifacts.length) {
  const manifest = writeManifestAndNotes();
  step("完成");
  for (const a of manifest.artifacts) console.log(`  ${a.file}  ${humanSize(a.bytes)}  ${a.sha256}`);
  console.log("\n下一步：把 release/ 里的文件传到网盘 + GitHub Release（附上 RELEASE_NOTES 的内容）。");
} else {
  log("没有生成任何产物（都跳过了？）");
}
