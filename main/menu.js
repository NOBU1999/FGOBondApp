"use strict";

const { Menu, BrowserWindow, dialog, app, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { getDbPath, getAppRoot } = require("./paths");
const { stopActiveEngine } = require("./ipc-handlers");
const appUpdater = require("./app-updater");

const GITHUB_URL = "https://github.com/NOBU1999/FGOBondApp";
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;
const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;
const MANUAL_NAME = "使用说明.txt";

function sendToFocused(channel, payload) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload || {});
  }
}

/** 操作手册路径（便携目录根下的 使用说明.txt） */
function getUserManualPath() {
  return path.join(getAppRoot(), MANUAL_NAME);
}

/** 用系统默认程序打开操作手册 */
async function openUserManual(win) {
  const target = win && !win.isDestroyed() ? win : BrowserWindow.getFocusedWindow();
  const file = getUserManualPath();
  if (!fs.existsSync(file)) {
    await dialog.showMessageBox(target, {
      type: "warning",
      title: "使用说明",
      message: `找不到 ${MANUAL_NAME}`,
      detail: `预期位置：${file}\n\n请确认程序目录完整（从官方发布包整体解压，不要只复制 exe）。`,
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "missing" };
  }
  const error = await shell.openPath(file);
  if (error) {
    await dialog.showMessageBox(target, {
      type: "error",
      title: "使用说明",
      message: "无法打开使用说明",
      detail: `${error}\n\n文件位置：${file}`,
      buttons: ["知道了"],
      noLink: true,
    });
    return { ok: false, reason: "open-failed", error };
  }
  return { ok: true, file };
}

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "退出",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "设置",
      submenu: [
        {
          label: "结果显示设置...",
          accelerator: "CmdOrCtrl+,",
          click: () => sendToFocused("menu:settings"),
        },
      ],
    },
    {
      label: "工具",
      submenu: [
        {
          label: "安装新包...",
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            await appUpdater.installPackage(win);
          },
        },
        {
          label: "回滚到上一版...",
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            await appUpdater.rollback(win);
          },
        },
        {
          label: "版本与更新信息...",
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            await appUpdater.showVersionInfo(win);
          },
        },
        { type: "separator" },
        {
          label: "重置数据库",
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            const { response } = await dialog.showMessageBox(win, {
              type: "warning",
              buttons: ["取消", "确认重置"],
              defaultId: 0,
              cancelId: 0,
              message: "确认重置数据库？",
              detail: [
                "将清空本地【静态数据】（从者 / 礼装 / 特性 / 灵衣），",
                "然后强制重新构建一次（优先用本地缓存，缓存缺失才联网）。",
                "",
                "个人数据不受影响：账号 / Box / 排除列表 / 固定预设 / 自定义礼装都会保留。",
                "重建前会自动备份，失败会自动回滚。",
                "",
                `数据库路径：${getDbPath()}`,
              ].join("\n"),
            });
            if (response === 1) {
              sendToFocused("menu:reset-database");
            }
          },
        },
      ],
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "使用说明",
          accelerator: "F1",
          click: async () => {
            await openUserManual(BrowserWindow.getFocusedWindow());
          },
        },
        {
          label: "打开程序目录",
          click: async () => {
            const error = await shell.openPath(getAppRoot());
            if (error) {
              const win = BrowserWindow.getFocusedWindow();
              await dialog.showMessageBox(win, {
                type: "error",
                title: "打开程序目录",
                message: "无法打开程序目录",
                detail: `${error}\n\n${getAppRoot()}`,
                buttons: ["知道了"],
                noLink: true,
              });
            }
          },
        },
        { type: "separator" },
        {
          label: "关于",
          click: async () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            const { response } = await dialog.showMessageBox(win, {
              type: "info",
              title: "关于 FGO牵绊推荐器",
              message: `FGO牵绊推荐器 v${app.getVersion()}`,
              detail: [
                "Windows 便携版 · Electron + Vue 3 + Python 引擎",
                "",
                `使用说明：${MANUAL_NAME}（程序目录下，可用 F1 打开）`,
                `程序目录：${getAppRoot()}`,
                "",
                `GitHub 项目：${GITHUB_URL}`,
                `问题反馈：${GITHUB_ISSUES_URL}`,
                `Release 下载：${GITHUB_RELEASES_URL}`,
                "",
                "数据来源：Atlas Academy API",
                "部分中文译名参考：Chaldea 项目（非官方翻译）",
                "Chaldea 项目：https://github.com/chaldea-center/chaldea",
                "开源许可：AGPL-3.0-only",
                "",
                "本工具仅用于非商业学习与游戏辅助用途。",
              ].join("\n"),
              buttons: ["使用说明", "打开 GitHub", "打开 Issues", "关闭"],
              defaultId: 0,
              cancelId: 3,
              noLink: true,
            });
            if (response === 0) await openUserManual(win);
            if (response === 1) shell.openExternal(GITHUB_URL);
            if (response === 2) shell.openExternal(GITHUB_ISSUES_URL);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, sendToFocused, stopActiveEngine, openUserManual, getUserManualPath };
