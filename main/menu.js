"use strict";

const { Menu, BrowserWindow, dialog, app, shell } = require("electron");
const { getDbPath } = require("./paths");
const { stopActiveEngine } = require("./ipc-handlers");

const GITHUB_URL = "https://github.com/NOBU1999/FGOBondApp";
const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues`;
const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

function sendToFocused(channel, payload) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload || {});
  }
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
              detail: `将清空本地用户配置并重新从 API 拉取全部数据。\n数据库路径：${getDbPath()}`,
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
              buttons: ["打开 GitHub", "打开 Issues", "关闭"],
              defaultId: 0,
              cancelId: 2,
              noLink: true,
            });
            if (response === 0) shell.openExternal(GITHUB_URL);
            if (response === 1) shell.openExternal(GITHUB_ISSUES_URL);
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, sendToFocused, stopActiveEngine };
