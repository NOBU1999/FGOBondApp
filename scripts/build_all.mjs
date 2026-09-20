#!/usr/bin/env node
"use strict";

/**
 * 一键出两个包：Windows 便携版 + 安卓 APK（阶段 6 产物）
 *
 * 用法：
 *   node scripts/build_all.mjs                      # 两个都出
 *   node scripts/build_all.mjs --skip-windows       # 只出 APK
 *   node scripts/build_all.mjs --skip-android       # 只出 Windows 包
 *   node scripts/build_all.mjs --android-data-refresh   # 只刷新安卓数据：不 bump 版本，只把数据序号 +1，只出 APK
 *   node scripts/build_all.mjs --force-engine       # 强制重跑 PyInstaller 重建 engine.exe
 *   node scripts/build_all.mjs --notes "本版更新内容…" --compatible-from 0.1.9
 *
 * 产物（都在 release/）：
 *   FGO牵绊推荐器-v<版本>-Android-<打包日期>.apk   正式签名 APK（versionName = <版本>+<打包日期>）
 *   FGO牵绊推荐器-v<版本>.7z              Windows 便携版（7z）
 *   FGO牵绊推荐器-v<版本>.zip             Windows 便携版（zip，兼容用）
 *   release-manifest-v<版本>.json         两个包的体积与 SHA-256
 *   RELEASE_NOTES_v<版本>.md              发布说明（模板 + 校验值，你补上更新内容即可粘贴到 Release）
 *
 * 说明：
 *   - 基础版本号唯一来源 = package.json（Windows 与安卓**同步**，代码更新时两边一起 +1）
 *     安卓另有两样：versionName = 0.1.13+260920（给人看，带打包日期）；
 *                   versionCode = 10113*10000 + androidDataRevision（给系统看，只能一样或变大）
 *     仅刷新安卓数据（不动代码）→ 用 --android-data-refresh：版本号不动，只把 androidDataRevision +1
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
import toolchain from "./lib/toolchain.cjs";

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
let SKIP_WINDOWS = has("--skip-windows");
const SKIP_ANDROID = has("--skip-android");
const FORCE_ENGINE = has("--force-engine");
// 仅刷新安卓数据：基础版本号不动，只把安卓数据序号 +1；只出 APK（Windows 那边数据是应用内更新的，不需要）
const ANDROID_DATA_REFRESH = has("--android-data-refresh");

// 安卓版本：versionName 给人看（带打包日期），versionCode 给系统看（只增不减，21.5 亿上限）
const BUILD_DATE = value(
  "--android-build-date",
  (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  })()
);
const ANDROID_BASE_CODE = (() => {
  const p = VERSION.split(".").map((x) => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  return p[0] * 10000 + p[1] * 100 + p[2];
})();
let ANDROID_REVISION = Number(PKG.androidDataRevision) || 1;
let ANDROID_VERSION_NAME = `${VERSION}+${BUILD_DATE}`;
let ANDROID_VERSION_CODE = ANDROID_BASE_CODE * 10000 + ANDROID_REVISION;

const RELEASE_DIR = path.join(ROOT, "release");
// 为什么这些不是写死的绝对路径：这是公开仓库，脚本里不该出现某个人的用户名/盘符/本地目录。
// 全部通过 scripts/lib/toolchain.cjs 解析（环境变量 → 常见安装位置）。
const SEVEN_ZIP = process.env.SEVEN_ZIP || "C:/Program Files/7-Zip/7z.exe";
const JAVA_HOME = toolchain.resolveJavaHome({ required: false });
const ANDROID_HOME = toolchain.resolveAndroidHome();
const GRADLE_USER_HOME = toolchain.resolveGradleUserHome();

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

// 仅刷新安卓数据：版本号不动，只把数据序号 +1（改 package.json 里那一行，保留原有排版）
if (ANDROID_DATA_REFRESH) {
  ANDROID_REVISION += 1;
  ANDROID_VERSION_CODE = ANDROID_BASE_CODE * 10000 + ANDROID_REVISION;
  const pkgPath = path.join(ROOT, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const next = raw.replace(/"androidDataRevision":\s*\d+/, `"androidDataRevision": ${ANDROID_REVISION}`);
  if (next === raw) fatal("package.json 里找不到 androidDataRevision 字段，无法自动 +1");
  writeFileSync(pkgPath, next, "utf8");
  if (!SKIP_WINDOWS) {
    SKIP_WINDOWS = true;
    log("--android-data-refresh：只出 APK（Windows 的数据是应用内更新的，不需要跟这一版）");
  }
  log(`已把安卓数据序号 +1 → ${ANDROID_REVISION}`);
}
log(`安卓版本：versionName=${ANDROID_VERSION_NAME}｜versionCode=${ANDROID_VERSION_CODE}`);

/**
 * 安卓版本自检：和上一次的打包记录比，**只允许变大或持平**。
 * 降级安装会被系统拒绝（最坏要用户卸载重装 → 本地数据全丢），所以变小必须拦下。
 */
function checkAndroidVersionRecord() {
  const recordFile = path.join(RELEASE_DIR, ".android-version.json");
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(recordFile, "utf8"));
  } catch (_) {
    /* 首次 */
  }
  if (previous && typeof previous.versionCode === "number") {
    if (ANDROID_VERSION_CODE < previous.versionCode) {
      fatal(
        `安卓 versionCode 变小了：上次 ${previous.versionCode}（${previous.versionName}）→ 这次 ${ANDROID_VERSION_CODE}（${ANDROID_VERSION_NAME}）\n` +
          "安卓会拒绝降级安装（用户得卸载重装 → 本地账号 / Box 全丢）。\n" +
          "请把 package.json 的 version 加一位，或用 --android-data-refresh（只把数据序号 +1）。"
      );
    }
    if (ANDROID_VERSION_CODE === previous.versionCode) {
      log(
        `⚠️ 安卓 versionCode 与上次相同（${ANDROID_VERSION_CODE}）：平级安装可以装，但系统里看不出差异；` +
          "数据刷新请用 --android-data-refresh"
      );
    }
  }
  return recordFile;
}

function rememberAndroidVersion(recordFile) {
  writeFileSync(
    recordFile,
    JSON.stringify(
      {
        versionName: ANDROID_VERSION_NAME,
        versionCode: ANDROID_VERSION_CODE,
        baseVersion: VERSION,
        dataRevision: ANDROID_REVISION,
        buildDate: BUILD_DATE,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf8"
  );
}

const artifacts = [];

/**
 * 出包前补齐缺失的从者头像。
 * 背景：头像 PNG 是随包发布的静态文件（renderer/assets/servantface/{id}.png），
 * 应用内「更新数据」只更新文字数据，不会下载图片 → 新从者上线后必须靠这一步补。
 * 失败只警告、不中断（断网或源站还没图时不该卡住发版）。
 */
function ensureMissingAvatars() {
  step("补齐缺失头像（游戏里新上的从者）");
  const script = path.join(ROOT, "scripts", "fetch_missing_avatars.py");
  if (!existsSync(script)) {
    log("跳过：找不到 scripts/fetch_missing_avatars.py");
    return;
  }
  const bonusFile = path.join(ROOT, "db", "event_bond_bonus.json");
  if (!existsSync(bonusFile)) {
    log("⚠️ 缺少 db/event_bond_bonus.json（先跑一次「更新数据」；本次包内将没有活动牵绊表）");
  }
  const python = process.env.PYTHON || "python";
  try {
    run(python, [script, "--no-repack", "--db", path.join(ROOT, "db", "fgo_data.db")]);
  } catch (err) {
    log(`⚠️ 补齐头像失败（继续出包）：${err.message}`);
  }
}

// ---------------------------------------------------------------- 安卓 APK
function buildAndroid() {
  step("安卓 APK（Capacitor + Chaquopy，正式签名）");
  if (!JAVA_HOME) {
    fatal(
      "安卓构建需要 JDK 21，但没找到 JDK。请设置环境变量 JAVA_HOME，例如：\n" +
        '  PowerShell:  $env:JAVA_HOME = "C:\\Program Files\\Java\\jdk-21"\n' +
        "  bash:        export JAVA_HOME=/usr/lib/jvm/jdk-21\n" +
        "（解析逻辑见 scripts/lib/toolchain.cjs）"
    );
  }
  if (!ANDROID_HOME) {
    fatal(
      "安卓构建需要 Android SDK，但没找到。请设置环境变量 ANDROID_HOME（或 ANDROID_SDK_ROOT），例如：\n" +
        '  PowerShell:  $env:ANDROID_HOME = "C:\\Users\\<你>\\AppData\\Local\\Android\\Sdk"\n' +
        "（解析逻辑见 scripts/lib/toolchain.cjs）"
    );
  }
  log(`工具链：JDK=${JAVA_HOME}｜SDK=${ANDROID_HOME}｜Gradle=${GRADLE_USER_HOME}`);
  if (!existsSync(path.join(ROOT, "android", "keystore.properties"))) {
    fatal("缺少 android/keystore.properties（正式签名配置）→ 先跑：node scripts/android/create_keystore.cjs");
  }
  const recordFile = checkAndroidVersionRecord();
  // 让界面里显示的版本 = 安卓 versionName（同一天、同一个号）
  process.env.FGO_ANDROID_VERSION = ANDROID_VERSION_NAME;
  npmRun("android:sync");
  run(
    path.join(ROOT, "android", "gradlew.bat"),
    [`-PandroidBuildDate=${BUILD_DATE}`, "assembleRelease", "--no-daemon", "--console=plain"],
    {
      cwd: path.join(ROOT, "android"),
      env: {
        ...process.env,
        JAVA_HOME,
        ANDROID_HOME,
        GRADLE_USER_HOME,
        JAVA_TOOL_OPTIONS: "-Duser.language=en -Duser.country=US",
      },
    }
  );

  const built = path.join(ROOT, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
  if (!existsSync(built)) fatal("没有产出 release APK：" + built);
  const dest = path.join(RELEASE_DIR, `${PRODUCT}-v${VERSION}-Android-${BUILD_DATE}.apk`);
  copyFileSync(built, dest);
  rememberAndroidVersion(recordFile);
  log(`→ ${path.relative(ROOT, dest)}（${humanSize(statSync(dest).size)}）`);
  log(`   版本名 ${ANDROID_VERSION_NAME}｜版本码 ${ANDROID_VERSION_CODE}`);
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
  const exeTimeBefore = existsSync(engineExe) ? statSync(engineExe).mtimeMs : 0;
  if (FORCE_ENGINE || stale) {
    log(stale && existsSync(engineExe) ? "引擎源码比 engine.exe 新 → 自动重建引擎" : "重建引擎（PyInstaller）");
    // 引擎重建要 pip 装依赖：默认给国内镜像，避免卡在默认源（实测曾被中断反复重试十几分钟）
    const pipEnv = { ...process.env, PIP_INDEX_URL: process.env.PIP_INDEX_URL || "https://pypi.tuna.tsinghua.edu.cn/simple" };
    run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:engine"], { env: pipEnv });
    // 防呆：脚本静默失败时（例如 .ps1 编码问题把命令吃进注释、或 PyInstaller 报错被吞）
    // 会出现"说重建了、其实还是旧 exe"，那就会把旧引擎打进包 → 这里必须挡住。
    if (!existsSync(engineExe) || statSync(engineExe).mtimeMs <= exeTimeBefore) {
      fatal("engine.exe 没有被更新 → 引擎构建静默失败了，别继续打包");
    }
    log(`engine.exe 已更新（${humanSize(statSync(engineExe).size)}）`);
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

  // 打包前最后一道卫生：清掉种子库的 SQLite 旁路文件。
  // 只读打开 WAL 模式的库也会生成 -wal/-shm，之前就被带进过发布包（自检会拦，但别让它有机会）。
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    rmSync(path.join(appDir, "db", `fgo_data.seed.db${suffix}`), { force: true });
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
  const versionCode = ANDROID_VERSION_CODE;

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
    androidVersionName: ANDROID_VERSION_NAME,
    androidVersionCode: versionCode,
    androidDataRevision: ANDROID_REVISION,
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
// 出包前自动补齐缺失从者头像（新从者上线后，头像 PNG 需要随包发布）。
// 失败只警告、不中断出包（断网/源站缺图时不该卡住发版）。
ensureMissingAvatars();
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
