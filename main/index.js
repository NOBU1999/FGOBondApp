"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const { registerIpcHandlers, stopActiveEngine } = require("./ipc-handlers");
const { buildMenu } = require("./menu");
const database = require("./database");
const { getDbPath } = require("./paths");
const { ensureRuntimeDb } = require("./runtime-db");

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// 渲染稳定性（Windows）
// ---------------------------------------------------------------------------
// 1) Chromium 在 Windows 上会做「窗口遮挡计算」：一旦判定窗口被别的窗口挡住，
//    就停止给该窗口出帧，表现为偶发假死（移动/缩放窗口才恢复）。Electron 官方
//    常见规避方式就是关掉这个特性。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

// 2) 允许用命令行 / 环境变量强制软件渲染，用于排查 GPU 驱动导致的假死：
//    FGO牵绊推荐器.exe --disable-gpu        （或 set FGO_DISABLE_GPU=1）
const forceSoftwareRendering =
  process.argv.includes("--disable-gpu") || process.env.FGO_DISABLE_GPU === "1";
if (forceSoftwareRendering) {
  app.disableHardwareAcceleration();
}

const RENDERER_LOG_PREFIX = "renderer";

let diagLogFile = null;
let reloadAttempts = 0;

function diagLogPath() {
  if (!diagLogFile) {
    const dir = path.join(path.dirname(getDbPath()), "backup");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      // ignore
    }
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    diagLogFile = path.join(dir, `${RENDERER_LOG_PREFIX}-${day}.log`);
  }
  return diagLogFile;
}

/** 渲染/GPU 诊断日志：出问题时用户把这个文件发回来即可定位 */
function diagLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    console.log(`[diag] ${message}`);
  } catch (_) {
    // ignore
  }
  try {
    fs.appendFileSync(diagLogPath(), line + "\n", "utf8");
  } catch (_) {
    // ignore
  }
}

let mainWindow = null;

function attachWindowDiagnostics(win) {
  const wc = win.webContents;

  wc.on("unresponsive", () => {
    // 渲染进程主线程卡住（JS 忙 / 死循环）：与「GPU 假死」区分开
    diagLog("WebContents unresponsive（渲染进程主线程无响应）");
  });
  wc.on("responsive", () => {
    diagLog("WebContents responsive（渲染进程已恢复响应）");
  });
  wc.on("render-process-gone", (_event, details) => {
    diagLog(
      `render-process-gone: reason=${details && details.reason} exitCode=${details && details.exitCode}`
    );
    // 自动恢复：重载一次，避免用户只能强杀进程
    if (reloadAttempts < 2 && !win.isDestroyed()) {
      reloadAttempts += 1;
      diagLog(`尝试自动重载界面（第 ${reloadAttempts} 次）`);
      setTimeout(() => {
        try {
          wc.reload();
        } catch (_) {
          // ignore
        }
      }, 800);
    }
  });
  wc.on("preload-error", (_event, preloadPath, error) => {
    diagLog(`preload-error: ${preloadPath} -> ${error && error.message}`);
  });
}

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
      // 窗口失焦/被遮挡时不限制渲染，避免回到前台后停留在旧帧
      backgroundThrottling: false,
    },
  });
  attachWindowDiagnostics(mainWindow);

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
        const accountInfo = await mainWindow.webContents.executeJavaScript(
          "window.fgo.listAccounts()"
        );
        const accountUi = await mainWindow.webContents.executeJavaScript(`(async () => {
          const select = document.querySelector('.account-select');
          if (!select) return { ok: false, error: '账号选择器未渲染' };
          const options = Array.from(select.options).map((o) => o.textContent);
          // 新建 -> 切换 -> 删除，验证多账号链路
          const created = await window.fgo.createAccount({ name: '__smoke__' });
          const switched = await window.fgo.setActiveAccount(created.id);
          const boxAfter = await window.fgo.getUserBox(created.id);
          const removed = await window.fgo.deleteAccount(created.id);
          return {
            ok: true,
            options,
            createdId: created.id,
            activeAfterSwitch: switched.activeId,
            boxRowsInNewAccount: boxAfter.length,
            accountsAfterDelete: removed.accounts.length,
          };
        })()`);
        if (!accountUi.ok) throw new Error("account smoke: " + accountUi.error);
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
          accountInfo,
          accountUi,
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

/**
 * 运行库 / 种子库分离：发布包只带 db/fgo_data.seed.db，
 * 个人数据固定在 db/fgo_data.db（不在发布包内，直接覆盖文件夹不会丢）。
 */
function prepareRuntimeDatabase() {
  try {
    const result = ensureRuntimeDb(path.dirname(getDbPath()));
    if (result && ["created", "refreshed"].includes(result.action)) {
      console.log(
        `[main] 运行库已就绪（${result.action}${result.from ? `: ${result.from} -> ${result.to}` : ""}）`
      );
    } else if (result && result.action === "failed") {
      console.error("[main] 运行库刷新失败:", result.error);
    }
  } catch (err) {
    console.error("[main] runtime db prepare error:", err.message);
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
    // 渲染/GPU 诊断：出问题时让用户把 db\backup\renderer-*.log 发回来
    try {
      diagLog(
        `启动 Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / ` +
          `软件渲染=${forceSoftwareRendering ? "强制开" : "否"}`
      );
      const gpuStatus = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : null;
      if (gpuStatus) diagLog(`GPU 特性状态: ${JSON.stringify(gpuStatus)}`);
    } catch (err) {
      diagLog(`GPU 状态读取失败: ${err.message}`);
    }

    // 子进程（GPU / utility）异常退出也记下来：能区分「GPU 崩了」和「JS 卡了」
    app.on("child-process-gone", (_event, details) => {
      diagLog(
        `child-process-gone: type=${details && details.type} reason=${details && details.reason} ` +
          `exitCode=${details && details.exitCode}`
      );
    });

    prepareRuntimeDatabase();
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
