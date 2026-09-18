"use strict";
/**
 * 一次性：生成安卓正式签名密钥（keystore）并写出 android/keystore.properties
 *
 * - 密钥默认放在**仓库外**的 `../android-keys/fgobond-release.jks`（可用环境变量
 *   FGO_KEYSTORE_DIR 改到别处）；仓库外 → 不会被 git 看到
 * - 密码随机生成，写进 android/keystore.properties（该文件已 gitignore）
 * - 两者都要**双备份**；丢失后老用户无法覆盖升级（只能卸载重装、数据会丢）
 *
 * 用法：node scripts/android/create_keystore.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const toolchain = require("../lib/toolchain.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const KEY_DIR = process.env.FGO_KEYSTORE_DIR || path.resolve(ROOT, "..", "android-keys");
const JKS = path.join(KEY_DIR, "fgobond-release.jks");
const PROPS = path.join(ROOT, "android", "keystore.properties");
const KEYTOOL = toolchain.resolveKeytool();
const ALIAS = "fgobond";

if (fs.existsSync(JKS)) {
  console.log("已存在，不覆盖：" + JKS);
  console.log("（如果确实要重新生成，先手动删除该文件，并注意：重新生成会导致老用户无法覆盖升级）");
  process.exit(0);
}
if (!fs.existsSync(KEYTOOL)) {
  console.error("找不到 keytool：" + KEYTOOL);
  process.exit(1);
}

fs.mkdirSync(KEY_DIR, { recursive: true });
const password = crypto.randomBytes(18).toString("base64url");

console.log("生成密钥：" + JKS);
execFileSync(
  KEYTOOL,
  [
    "-genkeypair",
    "-v",
    "-keystore", JKS,
    "-storepass", password,
    "-alias", ALIAS,
    "-keypass", password,
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-validity", "10000",
    "-dname", "CN=FGOBond, OU=Personal, O=FGOBond, L=Unknown, ST=Unknown, C=CN",
  ],
  { stdio: "inherit" }
);

// Gradle 的 rootProject.file(...) 是相对 android/ 解析的 → 按 KEY_DIR 实际位置算相对路径，
// 这样即使用 FGO_KEYSTORE_DIR 换目录也不会写错。
const storeFileRel = path.relative(path.join(ROOT, "android"), JKS).split(path.sep).join("/");
const props = [
  "# 安卓正式签名配置（本地文件，不进版本库；与 .jks 一起双备份）",
  "# 生成脚本：node scripts/android/create_keystore.cjs",
  "storeFile=" + storeFileRel,
  "storePassword=" + password,
  "keyAlias=" + ALIAS,
  "keyPassword=" + password,
  "",
].join("\n");
fs.writeFileSync(PROPS, props, "utf8");

console.log("");
console.log("✅ 完成");
console.log("   密钥文件：" + JKS);
console.log("   配置写入：" + PROPS);
console.log("");
console.log("⚠️ 请立刻备份这两样（网盘 + U盘/离线）：");
console.log("   1) " + JKS);
console.log("   2) " + PROPS + "（里面有密码）");
console.log("   丢失后果：老用户无法覆盖升级，只能卸载重装（Box/账号数据会丢）");
