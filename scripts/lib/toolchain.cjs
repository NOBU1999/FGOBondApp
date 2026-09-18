"use strict";

/**
 * 构建工具链路径解析。
 *
 * 为什么不写死路径：这是公开仓库，脚本里不该出现某个人的 Windows 用户名、
 * 盘符结构或本地目录（泄漏个人环境 + 别人 clone 下来无法使用）。
 *
 * 解析顺序：环境变量 → 常见安装位置 → 报错并把设置方法打出来。
 * 可用环境变量：
 *   JAVA_HOME         安卓构建用（必须 JDK 21）
 *   ANDROID_HOME / ANDROID_SDK_ROOT   安卓 SDK
 *   GRADLE_USER_HOME  Gradle 家目录（默认 ~/.gradle）
 *   SEVEN_ZIP         7-Zip 可执行文件
 *   FGO_KEYSTORE_DIR  签名密钥存放目录（默认 <仓库上级>/android-keys）
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function hasJavac(dir) {
  return isDir(dir) && (exists(path.join(dir, "bin", "javac.exe")) || exists(path.join(dir, "bin", "javac")));
}

function hasKeytool(dir) {
  return isDir(dir) && (exists(path.join(dir, "bin", "keytool.exe")) || exists(path.join(dir, "bin", "keytool")));
}

/** 从目录名粗略判断 JDK 大版本（jdk-21 / java-21-openjdk / 21.0.2 …），识别不出返回 0 */
function versionScore(name) {
  const m = name.match(/(\d{2})(?:[.\-_]|$)/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 8 && n <= 40 ? n : 0;
}

/** 常见 JDK 安装根目录（不含任何个人路径） */
function jdkSearchRoots() {
  return [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    path.join(os.homedir(), "AppData", "Local", "Programs"),
    path.join(os.homedir(), "AppData", "Local"),
    "/usr/lib/jvm",
    "/Library/Java/JavaVirtualMachines",
    "/opt",
  ].filter(Boolean);
}

const JDK_VENDORS = [
  "Java",
  "Eclipse Adoptium",
  "Eclipse Foundation",
  "Microsoft",
  "Amazon Corretto",
  "Zulu",
  "BellSoft",
  "Semeru",
  "Temurin",
  "OpenJDK",
  "jdk",
];

/**
 * 解析 JDK 家目录。安卓构建需要 JDK 21（Capacitor 8 / AGP 要求 Java 21 源版本）。
 *
 * 只认**带 javac 的 JDK**（JRE 会被排除——曾经把 Java 7 的 jre7 认成 JDK，
 * 结果 Gradle 报一堆看不懂的错）；优先版本号 21+，其次认不出版本号的 JDK。
 * @param {{ required?: boolean }} [opts] required=false 时找不到返回 null（Windows-only 构建用不到 Java）
 */
function resolveJavaHome(opts = {}) {
  const { required = false } = opts;
  if (hasJavac(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

  const found = [];
  for (const root of jdkSearchRoots()) {
    for (const vendor of JDK_VENDORS) {
      const vendorDir = path.join(root, vendor);
      if (!isDir(vendorDir)) continue;
      for (const entry of readdirSafe(vendorDir)) {
        const cand = path.join(vendorDir, entry);
        if (hasJavac(cand)) found.push({ path: cand, score: versionScore(entry) });
        // 某些发行版多一层目录（如 .../Temurin/jdk-21.0.1+12/bin/javac.exe）
        for (const inner of readdirSafe(cand)) {
          const cand2 = path.join(cand, inner);
          if (hasJavac(cand2)) found.push({ path: cand2, score: versionScore(inner) });
        }
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const pick = found.find((f) => f.score >= 21) || found[0];
  if (pick) return pick.path;

  if (required) {
    throw new Error(
      "找不到 JDK（安卓构建必须 JDK 21）。请设置环境变量 JAVA_HOME，例如：\n" +
        '  PowerShell:  $env:JAVA_HOME = "C:\\Program Files\\Java\\jdk-21"\n' +
        "  bash:        export JAVA_HOME=/usr/lib/jvm/jdk-21"
    );
  }
  return null;
}

/** 解析安卓 SDK 目录（不瞎猜：找不到就返回 null，由调用方报错提示） */
function resolveAndroidHome() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (isDir(env)) return env;
  const guesses = [
    path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"),
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    "/usr/lib/android-sdk",
  ];
  for (const g of guesses) if (isDir(g)) return g;
  return null;
}

/** 解析 Gradle 家目录（默认系统标准位置 ~/.gradle） */
function resolveGradleUserHome() {
  return process.env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle");
}

/** 解析 keytool（在 JDK 里） */
function resolveKeytool() {
  const home = resolveJavaHome({ required: false });
  if (!hasKeytool(home)) {
    throw new Error(
      "找不到 keytool。请设置 JAVA_HOME 指向一个 JDK（内含 bin/keytool）。\n" +
        '  PowerShell:  $env:JAVA_HOME = "C:\\Program Files\\Java\\jdk-21"'
    );
  }
  return path.join(home, "bin", exists(path.join(home, "bin", "keytool.exe")) ? "keytool.exe" : "keytool");
}

module.exports = {
  resolveJavaHome,
  resolveAndroidHome,
  resolveGradleUserHome,
  resolveKeytool,
  isDir,
  exists,
};
