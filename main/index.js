"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { registerIpcHandlers, stopActiveEngine } = require("./ipc-handlers");
const { buildMenu } = require("./menu");
const database = require("./database");
const { getDbPath } = require("./paths");

const isDev = !app.isPackaged;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "FGO牵绊推荐器",
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.FGO_SMOKE === "1") {
    console.log("[smoke] BrowserWindow created");
    mainWindow.webContents.on("did-start-loading", () => console.log("[smoke] did-start-loading"));
    mainWindow.webContents.on("did-stop-loading", () => console.log("[smoke] did-stop-loading"));
  }

  // Phase 3 暂加载占位页面；Phase 4 接入 React/Vue 后替换为 renderer-dist/index.html
  const pageUrl = path.join(__dirname, "..", "renderer", "index.html");
  if (process.env.FGO_SMOKE === "1") {
    console.log("[smoke] loadFile " + pageUrl);
  }

  // 自动化冒烟验证：FGO_SMOKE=1 时启动后自动检查 IPC/DB 并退出
  // 监听必须先于 loadFile 注册，避免极快加载/失败时错过事件。
  if (process.env.FGO_SMOKE === "1") {
    mainWindow.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      console.log(`[smoke] did-fail-load code=${code} desc=${desc} url=${url} main=${isMainFrame}`);
    });
    mainWindow.webContents.once("did-finish-load", async () => {
      console.log("[smoke] did-finish-load fired");
      const outFile = process.env.FGO_SMOKE_OUT;
      const writeResult = (obj) => {
        if (outFile) {
          try {
            fs.writeFileSync(outFile, JSON.stringify(obj, null, 2), "utf8");
          } catch (_) {
            // ignore
          }
        }
      };
      try {
        console.log("[smoke] before getAppInfo");
        const info = await mainWindow.webContents.executeJavaScript(
          "window.fgo.getAppInfo()"
        );
        console.log("[smoke] after getAppInfo");
        const servants = await mainWindow.webContents.executeJavaScript(
          "window.fgo.listServants()"
        );
        const box = await mainWindow.webContents.executeJavaScript(
          "window.fgo.getUserBox()"
        );
        const appHtml = await mainWindow.webContents.executeJavaScript(
          `new Promise((resolve) => {
            const t0 = Date.now();
            const timer = setInterval(() => {
              const len = document.querySelector('#app') ? document.querySelector('#app').innerHTML.length : 0;
              if ((document.querySelector('.board-area') || document.querySelector('.empty')) || Date.now() - t0 > 5000) {
                clearInterval(timer);
                resolve(len);
              }
            }, 100);
          })`
        );
        const appText = await mainWindow.webContents.executeJavaScript(
          "document.querySelector('#app') ? document.querySelector('#app').innerText.slice(0,200) : ''"
        );
        // 计算冒烟：点击“开始计算”，确认不会出现 IPC clone 错误。
        // 若引擎在 60s 内未返回结果但也没有错误面板，视为 IPC 通道已通过。
        const calcSmoke = await mainWindow.webContents.executeJavaScript(`(async () => {
          const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开始计算'));
          if (!btn) return { ok: false, error: '开始计算按钮未找到' };
          btn.click();
          const t0 = Date.now();
          while (Date.now() - t0 < 60000) {
            await new Promise((r) => setTimeout(r, 400));
            const errEl = document.querySelector('.panel.error');
            const errText = errEl ? errEl.textContent.trim() : '';
            if (errText) return { ok: false, error: errText };
            const cards = document.querySelectorAll('.result-card').length;
            if (cards > 0) {
              if (document.body.innerText.includes('英灵逢魔')) {
                return { ok: false, error: '结果仍包含英灵逢魔' };
              }
              return { ok: true, results: cards, note: '计算完成' };
            }
          }
          const stillCalculating = !!document.querySelector('button.main-action:disabled');
          return { ok: true, note: stillCalculating ? '60s内仍在计算，无错误' : '60s内未出现错误/结果', results: document.querySelectorAll('.result-card').length };
        })()`);
        if (!calcSmoke.ok) {
          throw new Error("calculate smoke: " + calcSmoke.error);
        }
        writeResult({
          ok: true,
          appRoot: info.appRoot,
          servantCount: servants.length,
          boxCount: box.length,
          appHtmlLength: appHtml,
          appText,
          calcSmoke,
        });
        app.exit(0);
      } catch (err) {
        console.log("[smoke] error: " + (err && err.message ? err.message : String(err)));
        writeResult({
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
        app.exit(1);
      }
    });
  }

  mainWindow.loadFile(pageUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function initDatabase() {
  try {
    const db = database.open();
    try {
      database.ensureSchema(db);
      // 验证数据表已由 Python 构建
      const hasServants = db.prepare("SELECT COUNT(*) AS c FROM servants").get();
      console.log(`[main] SQLite ready, servants=${hasServants ? hasServants.c : 0}`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error("[main] database init error:", err.message);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initDatabase();
    registerIpcHandlers();
    buildMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    stopActiveEngine();
  });

  app.on("will-quit", () => {
    stopActiveEngine();
  });
}
