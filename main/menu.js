"use strict";

const { Menu, BrowserWindow, dialog, app } = require("electron");
const { getDbPath } = require("./paths");
const { stopActiveEngine } = require("./ipc-handlers");

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
          label: "导出方案",
          accelerator: "CmdOrCtrl+E",
          click: () => sendToFocused("menu:export"),
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
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
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            dialog.showMessageBox(win, {
              type: "info",
              title: "关于",
              message: "FGO牵绊推荐器",
              detail: "便携版 Electron 应用\n数据源：Atlas Academy API",
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu, sendToFocused, stopActiveEngine };
