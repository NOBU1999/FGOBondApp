"use strict";

/**
 * 「检查软件更新」：只查**最新版本号**，不下载、不安装（安装走菜单「工具 → 安装新包」，由 updater.exe 完成）。
 *
 * 为什么按"多个源"依次试：国内直连 GitHub 不稳定，所以
 *   ① 清华 GitHub 镜像（github-release）：只有被该镜像收录的仓库才有；没收录就自动往下试
 *   ② GitHub Releases API：官方、信息最全（版本号 + 发布页地址 + 更新说明）
 *   ③ jsDelivr CDN 上仓库里的 package.json：只有版本号，但国内通常最快
 * 第一个给出有效版本号的源就用它，并把"试过哪些源、各自结果"如实返回给界面显示。
 *
 * 只读，不写任何文件；拿到的版本号只与程序自带的 version.json 比较。
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { app, shell } = require("electron");
const { getAppRoot } = require("./paths");

const OWNER = "NOBU1999";
const REPO = "FGOBondApp";
const GITHUB_RELEASES = `https://github.com/${OWNER}/${REPO}/releases`;
const BILIBILI_DYNAMIC = "https://space.bilibili.com/431124482/dynamic";

const SOURCES = [
  {
    key: "tuna",
    label: "清华 GitHub 镜像",
    kind: "html",
    url: `https://mirrors.tuna.tsinghua.edu.cn/github-release/${OWNER}/${REPO}/LatestRelease/`,
  },
  {
    key: "github",
    label: "GitHub Releases",
    kind: "github",
    url: `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
  },
  {
    key: "jsdelivr",
    label: "jsDelivr CDN",
    kind: "package",
    url: `https://fastly.jsdelivr.net/gh/${OWNER}/${REPO}@main/package.json`,
  },
];

/** 允许用系统浏览器打开的站点（界面上那几个链接；避免"把任意 URL 丢给浏览器"） */
const EXTERNAL_HOSTS = new Set([
  "space.bilibili.com",
  "github.com",
  "api.github.com",
  "mirrors.tuna.tsinghua.edu.cn",
  "fastly.jsdelivr.net",
  "cdn.jsdelivr.net",
]);

function currentVersion() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(getAppRoot(), "version.json"), "utf8"));
    if (info && info.version) return String(info.version);
  } catch (_) {
    /* 没有 version.json（开发态）→ 退回 Electron 读到的版本 */
  }
  try {
    if (app && typeof app.getVersion === "function") return String(app.getVersion());
  } catch (_) {
    /* 纯 Node 里跑（离线探针）时没有 app 对象 */
  }
  return "0.0.0";
}

function fetchText(url, { timeoutMs = 12000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          // GitHub API 不带 UA 会 403
          "User-Agent": `FGOBondApp/${currentVersion()} (update-check)`,
          Accept: "application/vnd.github+json, application/json, text/html;q=0.9, */*;q=0.8",
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          fetchText(next, { timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (data.length < 512 * 1024) data += chunk;
        });
        res.on("end", () => resolve(data));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("超时"));
    });
    req.on("error", reject);
  });
}

function parseVersion(text) {
  const m = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { raw: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i] ? 1 : -1;
  }
  return 0;
}

/** 每个源各自解析出 { version, releaseUrl, notes } */
function parseSource(source, text) {
  if (source.kind === "github") {
    const data = JSON.parse(text);
    const version = parseVersion(data.tag_name || data.name);
    if (!version) throw new Error("响应里没有版本号");
    return {
      version: version.raw,
      releaseUrl: data.html_url || GITHUB_RELEASES,
      notes: String(data.body || "").slice(0, 500),
      publishedAt: data.published_at || "",
    };
  }
  if (source.kind === "package") {
    const data = JSON.parse(text);
    const version = parseVersion(data.version);
    if (!version) throw new Error("package.json 里没有版本号");
    return { version: version.raw, releaseUrl: GITHUB_RELEASES, notes: "" };
  }
  // 清华镜像的 LatestRelease 目录页：从附件名里取版本号
  const version = parseVersion(text);
  if (!version) throw new Error("镜像页里没有版本号（该仓库可能没被镜像收录）");
  return {
    version: version.raw,
    releaseUrl: `https://mirrors.tuna.tsinghua.edu.cn/github-release/${OWNER}/${REPO}/`,
    notes: "",
  };
}

async function checkAppUpdate() {
  const current = currentVersion();
  const checks = [];
  let found = null;
  for (const source of SOURCES) {
    try {
      const text = await fetchText(source.url);
      const parsed = parseSource(source, text);
      checks.push({ key: source.key, label: source.label, ok: true, version: parsed.version });
      if (!found) found = { source, ...parsed };
    } catch (err) {
      checks.push({
        key: source.key,
        label: source.label,
        ok: false,
        detail: String((err && err.message) || err),
      });
    }
  }

  if (!found) {
    return {
      ok: false,
      current,
      checks,
      message: "所有更新源都连不上（可能是网络问题）",
      githubUrl: GITHUB_RELEASES,
      bilibiliUrl: BILIBILI_DYNAMIC,
    };
  }

  return {
    ok: true,
    current,
    latest: found.version,
    hasUpdate: compareVersion(found.version, current) > 0,
    source: { key: found.source.key, label: found.source.label },
    releaseUrl: found.releaseUrl || GITHUB_RELEASES,
    notes: found.notes || "",
    publishedAt: found.publishedAt || "",
    checks,
    githubUrl: GITHUB_RELEASES,
    bilibiliUrl: BILIBILI_DYNAMIC,
  };
}

/** 界面请求用系统浏览器打开链接（只放行白名单里的站点） */
function openExternal(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_) {
    throw new Error("链接格式不对");
  }
  if (parsed.protocol !== "https:" || !EXTERNAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`不允许打开的链接：${url}`);
  }
  shell.openExternal(parsed.toString());
  return { ok: true, url: parsed.toString() };
}

module.exports = { checkAppUpdate, openExternal, GITHUB_RELEASES, BILIBILI_DYNAMIC, EXTERNAL_HOSTS };
