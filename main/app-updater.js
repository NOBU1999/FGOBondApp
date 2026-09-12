"use strict";

/**
 * 独立更新器接线（v0.1.10）
 *
 * 全部解析/校验/安装逻辑都在独立的 updater.exe 里完成（Python，源码见 updater/updater.py），
 * 主进程只负责：选包 → 一句确认 → 拉起 updater.exe → 退出自己。
 * 这样「菜单入口」和「双击 updater.exe」走的是同一套代码，行为一致。
 */

const { app, dialog, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getAppRoot } = require("./paths");

const UPDATER_EXE = "updater.exe";
const UPDATES_DIR = path.join("db", "updates");
const LAST_INSTALL = "last-install.json";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function getUpdaterPath() {
  return path.join(getAppRoot(), UPDATER_EXE);
}

function getVersionInfo() {
  return (
    readJson(path.join(getAppRoot(), "version.json")) || {
      appId: "fgo-bond-recommender",
      version: app.getVersion(),
    }
  );
}

/** 上一次安装记录 + 是否还留着可回滚的安装包 */
function getUpdateStatus() {
  const info = getVersionInfo();
  const record = readJson(path.join(getAppRoot(), UPDATES_DIR, LAST_INSTALL)) || {};
  let rollbackPackage = null;
  if (record.keptPackage) {
    const candidate = path.join(getAppRoot(), UPDATES_DIR, record.keptPackage);
    if (fs.existsSync(candidate)) rollbackPackage = candidate;
  }
  return {
    version: info.version || app.getVersion(),
    updaterAvailable: fs.existsSync(getUpdaterPath()),
    lastInstall: record,
    rollbackPackage,
  };
}

function launchUpdater(args) {
  const exe = getUpdaterPath();
  if (!fs.existsSync(exe)) {
    throw new Error(`未找到更新器：${exe}\n请使用官方发布包（内含 updater.exe）。`);
  }
  const child = spawn(exe, args, {
    cwd: getAppRoot(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function confirm(win, options) {
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["开始安装", "取消"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    ...options,
  });
  return response === 0;
}

async function pickPackage(win, { title }) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title,
    properties: ["openFile"],
    defaultPath: app.getPath("downloads"),
    filters: [
      { name: "安装包 (*.zip;*.7z)", extensions: ["zip", "7z"] },
      { name: "全部文件", extensions: ["*"] },
    ],
  });
  if (canceled || !filePaths || !filePaths.length) return null;
  return filePaths[0];
}

/** 工具 → 安装新包… */
async function installPackage(win) {
  const status = getUpdateStatus();
  if (!status.updaterAvailable) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "安装新包",
      message: "当前版本没有附带更新器 updater.exe",
      detail:
        "请从 GitHub Releases 下载官方发布包，按「使用说明」手动解压覆盖即可；" +
        "从下一个版本起就能在菜单里直接安装新包。",
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "no-updater" };
  }

  const file = await pickPackage(win, { title: "选择新版本安装包（zip 或 7z）" });
  if (!file) return { ok: false, reason: "canceled" };

  let sizeText = "";
  try {
    sizeText = `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
  } catch (_) {
    sizeText = "未知大小";
  }

  const ok = await confirm(win, {
    title: "安装新包",
    message: "将关闭程序并安装新包，继续？",
    detail: [
      `安装包：${path.basename(file)}（${sizeText}）`,
      `当前版本：v${status.version}`,
      "",
      "个人的账号 / Box / 排除列表 / 固定预设会自动保留，",
      "更新前还会在 db\\backup 里留一份运行库快照。",
      "",
      "接下来由更新器显示包内版本与兼容范围，可在那一步取消。",
    ].join("\n"),
  });
  if (!ok) return { ok: false, reason: "canceled" };

  try {
    launchUpdater([
      "--package",
      file,
      "--app-dir",
      getAppRoot(),
      "--pid",
      String(process.pid),
      "--quiet",
      "--relaunch-on-cancel",
    ]);
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "安装新包",
      message: "无法启动更新器",
      detail: String((err && err.message) || err),
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "spawn-failed" };
  }

  setTimeout(() => app.quit(), 200);
  return { ok: true, installing: path.basename(file) };
}

/** 工具 → 回滚到上一版… */
async function rollback(win) {
  const status = getUpdateStatus();
  if (!status.updaterAvailable) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "回滚到上一版",
      message: "当前版本没有附带更新器 updater.exe",
      detail: "请手动解压旧版本发布包覆盖程序文件（个人数据不会丢）。",
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "no-updater" };
  }

  let file = status.rollbackPackage;
  let detail = "";
  if (file) {
    detail = [
      `保留的安装包：${path.basename(file)}`,
      `对应版本：v${(status.lastInstall && status.lastInstall.version) || "未知"}`,
      `当前版本：v${status.version}`,
      "",
      "将用这个安装包重新安装一次，账号 / Box / 排除 / 预设都会保留。",
    ].join("\n");
  } else {
    detail = [
      "没有找到保留下来的安装包。",
      "请选择旧版本发布包（zip / 7z），回滚过程同样会保留个人数据。",
    ].join("\n");
  }

  const ok = await confirm(win, {
    title: "回滚到上一版",
    message: file ? "确认用保留的安装包回滚？" : "选择旧版本安装包回滚",
    detail,
  });
  if (!ok) return { ok: false, reason: "canceled" };

  if (!file) {
    file = await pickPackage(win, { title: "选择要回滚到的旧版本安装包" });
    if (!file) return { ok: false, reason: "canceled" };
  }

  try {
    launchUpdater([
      "--package",
      file,
      "--app-dir",
      getAppRoot(),
      "--pid",
      String(process.pid),
      "--mode",
      "rollback",
      "--quiet",
      "--relaunch-on-cancel",
    ]);
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "回滚到上一版",
      message: "无法启动更新器",
      detail: String((err && err.message) || err),
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "spawn-failed" };
  }

  setTimeout(() => app.quit(), 200);
  return { ok: true, rollingBack: path.basename(file) };
}

/** 关于窗口里显示的版本/更新信息 */
async function showVersionInfo(win) {
  const status = getUpdateStatus();
  await dialog.showMessageBox(win, {
    type: "info",
    title: "版本信息",
    message: `FGO牵绊推荐器 v${status.version}`,
    detail: [
      `程序目录：${getAppRoot()}`,
      `更新器：${status.updaterAvailable ? "已附带" : "缺失"}`,
      status.lastInstall && status.lastInstall.installedAt
        ? `上次更新：v${status.lastInstall.from || "?"} → v${status.lastInstall.version}（${status.lastInstall.installedAt}）`
        : "上次更新：无记录",
      status.rollbackPackage
        ? `可回滚安装包：${path.basename(status.rollbackPackage)}`
        : "可回滚安装包：无（本次更新时未保留）",
    ].join("\n"),
    buttons: ["关闭"],
    noLink: true,
  });
  return { ok: true };
}

module.exports = {
  installPackage,
  rollback,
  showVersionInfo,
  getUpdateStatus,
  UPDATES_DIR,
  LAST_INSTALL,
};
