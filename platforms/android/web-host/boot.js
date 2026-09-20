/**
 * 安卓（WebView）宿主启动脚本 —— 经典脚本，必须在 app.js **之前**加载
 *
 * 做三件事：
 *   1. 先给界面装一个「排队代理」：app.js 可以立刻调用 window.fgo.*，调用会排队等待
 *   2. 异步初始化：sql.js（WASM SQLite）+ 载入数据库 + 用 shared/domain 组装领域层
 *   3. 就绪后切到真实实现，并处理持久化（把内存库写回应用数据目录）
 *
 * 用法（由 scripts/android/build-web-bundle.mjs 组装到 index.html）：
 *   <script src="./vendor/sqljs/sql-wasm.js"></script>   <!-- 提供 window.initSqlJs -->
 *   <script src="./platforms/android/web-host/boot.js"></script>
 *   <script src="./app.js"></script>                     <!-- 界面，会调用 window.fgo.* -->
 *
 * 注意：本文件依赖 window.initSqlJs、window.Capacitor（可选）以及同目录的 ESM 模块。
 */

(function () {
  "use strict";

  // ---- 与 preload.js 完全一致的 36 个方法名 ----
  const DATA_METHODS = [
    "getAppInfo",
    "setServerRegion",
    "setGenericBondParticipation",
    "setNonParticipatingCraftIds",
    "getCostumeNames",
    "listServants",
    "getServant",
    "getStageTraits",
    "getAllStageTraits",
    "listBondCrafts",
    "listAllCrafts",
    "getUserBox",
    "saveUserBox",
    "resetUserBox",
    "importCapture",
    "getExclusions",
    "saveExclusions",
    "listCustomCrafts",
    "saveCustomCrafts",
    "listUserTeams",
    "saveUserTeam",
    "deleteUserTeam",
    "getEventBondBonuses",
    "listAccounts",
    "createAccount",
    "renameAccount",
    "duplicateAccount",
    "deleteAccount",
    "setActiveAccount",
  ];

  const progressCallbacks = [];
  const pendingCalls = [];
  let realBridge = null;
  let initError = null;

  // -------------------------------------------------------------------------
  // 诊断日志（本地文件 + 内存环形缓冲，界面设置里可读取/复制）
  //   记：脚本报错、未处理的 Promise、初始化失败、引擎报错、头像下载失败、保存失败
  //   注意：安卓没有"程序目录"给用户翻，所以不做成文件给用户找，而是让界面能直接复制
  // -------------------------------------------------------------------------
  const DIAG_FILE = "fgobond-log.txt";
  const DIAG_MAX_LINES = 200;
  const diagLines = [];
  let diagSaveTimer = null;

  function pushDiag(level, message) {
    let line;
    try {
      line = `[${new Date().toISOString()}] ${level}: ${message}`;
      diagLines.push(line);
      if (diagLines.length > DIAG_MAX_LINES) diagLines.splice(0, diagLines.length - DIAG_MAX_LINES);
      console.log("[diag]", line);
    } catch (_) {
      return;
    }
    scheduleDiagSave();
  }

  function scheduleDiagSave() {
    if (diagSaveTimer) return;
    diagSaveTimer = setTimeout(() => {
      diagSaveTimer = null;
      const fs = getFilesystem();
      if (!fs) return;
      try {
        const p = fs.writeFile({
          path: DIAG_FILE,
          directory: "DATA",
          data: diagLines.join("\n"),
          recursive: true,
        });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }, 800);
  }

  window.addEventListener("error", (event) => {
    const where = event && event.filename ? ` @ ${event.filename}:${event.lineno}` : "";
    pushDiag("error", `${(event && event.message) || "脚本错误"}${where}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    pushDiag("rejection", (reason && (reason.message || reason)) || "未处理的 Promise 拒绝");
  });

  function emitProgress(text) {
    for (const cb of progressCallbacks) {
      try {
        cb(String(text ?? ""));
      } catch (_) {
        /* ignore */
      }
    }
  }

  function makeDeferred(methodName) {
    return function deferredMethod(...args) {
      return new Promise((resolve, reject) => {
        if (realBridge) {
          try {
            resolve(realBridge[methodName](...args));
          } catch (err) {
            reject(err);
          }
          return;
        }
        if (initError) {
          reject(initError);
          return;
        }
        pendingCalls.push({ methodName, args, resolve, reject });
      });
    };
  }

  // ---- 先装代理，界面可以马上用 ----
  const api = {};
  for (const name of DATA_METHODS) api[name] = makeDeferred(name);

  // 平台能力：安卓版暂不支持的部分给出明确提示（而不是静默失败）
  api.calculate = makeDeferred("calculate");
  api.cancelEngine = () => {
    const cap = window.Capacitor;
    const plugin = cap && cap.Plugins && cap.Plugins.PythonEngine;
    if (plugin && typeof plugin.cancel === "function") {
      return plugin.cancel().catch(() => ({ ok: true }));
    }
    return Promise.resolve({ ok: true });
  };
  api.updateData = () =>
    Promise.reject(new Error("安卓版不支持联网更新数据；数据随安装包发布（更新请下载新版 APK）"));
  api.resetStaticData = () =>
    Promise.reject(new Error("安卓版暂不支持重置静态数据；可卸载重装以恢复初始数据"));
  api.copyText = async (text) => {
    const value = String(text ?? "");
    try {
      await navigator.clipboard.writeText(value);
      return { ok: true };
    } catch (_) {
      // 兜底：选中提示
      try {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return { ok };
      } catch (err) {
        throw new Error("复制失败：请长按手动选择复制");
      }
    }
  };
  // ---- 头像：包内没有时按需下载（只下公开图片，不上传任何数据） ----
  //   包内的头像与随包数据库同一次构建产出，正常不会缺；缺了（例如出包时没网）
  //   就在这里补一张，写到应用数据目录，下次还在。
  const AVATAR_CDN = "https://static.atlasacademy.io/{region}/Faces/f_{id}0.png";
  const AVATAR_REGIONS = ["JP", "CN"];

  function isPngBytes(bytes) {
    return !!bytes && bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }

  async function readAvatarFromDataDir(id) {
    const fs = getFilesystem();
    if (!fs) return null;
    try {
      const res = await fs.readFile({ path: `avatars/${id}.png`, directory: "DATA" });
      const data = res && res.data;
      if (typeof data === "string" && data) return `data:image/png;base64,${data}`;
    } catch (_) {
      /* 还没下载过，属正常 */
    }
    return null;
  }

  async function downloadAvatar(id) {
    let lastError = null;
    for (const region of AVATAR_REGIONS) {
      const url = AVATAR_CDN.replace("{region}", region).replace("{id}", String(id));
      try {
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) {
          lastError = new Error(`${region} HTTP ${resp.status}`);
          continue;
        }
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (!isPngBytes(bytes)) {
          lastError = new Error(`${region} 返回的不是 PNG`);
          continue;
        }
        const fs = getFilesystem();
        if (fs) {
          try {
            await fs.writeFile({
              path: `avatars/${id}.png`,
              directory: "DATA",
              data: bytesToBase64(bytes),
              recursive: true,
            });
          } catch (err) {
            pushDiag("warn", `头像落盘失败 ${id}：${(err && err.message) || err}`);
          }
        }
        return `data:image/png;base64,${bytesToBase64(bytes)}`;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("下载失败");
  }

  api.getAvatarData = async (id) => {
    const key = String(id == null ? "" : id).replace(/[^0-9]/g, "");
    if (!key) return { ok: false, error: "无效的从者 ID" };
    try {
      const local = await readAvatarFromDataDir(key);
      if (local) return { ok: true, dataUrl: local, cached: true };
      const dataUrl = await downloadAvatar(key);
      return { ok: true, dataUrl, cached: false };
    } catch (err) {
      const message = (err && err.message) || String(err);
      pushDiag("warn", `头像获取失败 ${key}：${message}`);
      return { ok: false, error: message };
    }
  };

  // ---- 诊断日志读取/清空（初始化失败时也能用，所以不走排队代理） ----
  api.getDiagnosticLog = async () => {
    const fs = getFilesystem();
    // 先强制刷一次：落盘是防抖的，直接读文件可能缺最新几行（而最新那几行往往就是要看的）
    if (fs) {
      try {
        await fs.writeFile({
          path: DIAG_FILE,
          directory: "DATA",
          data: diagLines.join("\n"),
          recursive: true,
        });
      } catch (_) {
        /* 刷不进去也无妨，下面读内存 */
      }
    }
    let persisted = "";
    if (fs) {
      try {
        const res = await fs.readFile({ path: DIAG_FILE, directory: "DATA" });
        if (res && typeof res.data === "string") persisted = res.data;
      } catch (_) {
        /* 没有文件就是还没记过 */
      }
    }
    return {
      ok: true,
      text: persisted || diagLines.join("\n"),
      path: `DATA/${DIAG_FILE}`,
    };
  };

  api.clearDiagnosticLog = async () => {
    diagLines.length = 0;
    const fs = getFilesystem();
    if (fs) {
      try {
        await fs.writeFile({ path: DIAG_FILE, directory: "DATA", data: "", recursive: true });
      } catch (_) {
        /* ignore */
      }
    }
    return { ok: true };
  };

  api.onEngineProgress = (cb) => {
    if (typeof cb === "function") progressCallbacks.push(cb);
    return () => {
      const i = progressCallbacks.indexOf(cb);
      if (i >= 0) progressCallbacks.splice(i, 1);
    };
  };
  api.onMenuAction = () => () => {}; // 安卓没有系统菜单

  window.fgo = api;

  // ---- 异步初始化 ----
  const DB_FILE_IN_APP = "fgo_data.db";
  const DB_FILE_IN_PACKAGE = "./db/fgo_data.db";
  const WRITE_METHODS = new Set([
    "createAccount",
    "renameAccount",
    "duplicateAccount",
    "deleteAccount",
    "setActiveAccount",
    "setServerRegion",
    "setGenericBondParticipation",
    "setNonParticipatingCraftIds",
    "saveUserBox",
    "resetUserBox",
    "importCapture",
    "saveExclusions",
    "saveCustomCrafts",
    "saveUserTeam",
    "deleteUserTeam",
  ]);

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function getFilesystem() {
    const cap = window.Capacitor;
    if (cap && cap.Plugins && cap.Plugins.Filesystem) return cap.Plugins.Filesystem;
    return null;
  }

  /** 优先读应用数据目录里的库（用户改过的），没有就用随包的那份 */
  async function loadDatabaseBytes() {
    const fs = getFilesystem();
    if (fs) {
      try {
        const res = await fs.readFile({ path: DB_FILE_IN_APP, directory: "DATA" });
        const data = res && res.data;
        if (typeof data === "string") return base64ToBytes(data);
        if (data && typeof data.text === "function") return new Uint8Array(await data.arrayBuffer());
      } catch (_) {
        /* 首次运行没有该文件，属正常 */
      }
    }
    const resp = await fetch(DB_FILE_IN_PACKAGE);
    if (!resp.ok) throw new Error("读不到随包数据库：" + DB_FILE_IN_PACKAGE);
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** 把内存库写回应用数据目录（累加式保存；Box 保存等操作不频繁，可接受） */
  let saveTimer = null;
  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const fs = getFilesystem();
      if (!fs || !window.__fgoDb) return;
      try {
        const bytes = window.__fgoDb.export();
        await fs.writeFile({
          path: DB_FILE_IN_APP,
          directory: "DATA",
          data: bytesToBase64(bytes),
          recursive: true,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        emitProgress("保存本地数据失败：" + message);
        pushDiag("warn", "保存本地数据失败：" + message);
      }
    }, 600);
  }

  async function init() {
    if (typeof window.initSqlJs !== "function") {
      throw new Error("sql.js 未加载（vendor/sqljs/sql-wasm.js 缺失）");
    }
    emitProgress("正在载入本地数据库...");
    pushDiag("info", `开始载入本地数据库（v${window.__FGO_APP_VERSION || "?"}）`);
    const SQL = await window.initSqlJs({ locateFile: (file) => "./vendor/sqljs/" + file });
    const bytes = await loadDatabaseBytes();
    const db = new SQL.Database(bytes);
    window.__fgoDb = db;

    const [{ createWebHost }, { createDataBridge }] = await Promise.all([
      import("./create-host.mjs"),
      // 注意层级：本文件在 public/platforms/android/web-host/ → 上三级才是 public/
      import("../../../shared/bridge/data-bridge.mjs"),
    ]);

    // 与桌面一致：首次运行要保证账号表存在（内含旧数据迁移逻辑）
    const host = createWebHost({ db });
    host.domain.accounts.ensureAccountSchema();

    const bridge = createDataBridge({
      domain: host.domain,
      platform: {
        appRoot: "(android)",
        dbPath: DB_FILE_IN_APP,
        version: window.__FGO_APP_VERSION || "",
        platformName: "android",
        getEventBondBonuses: async () => {
          // 安卓端：活动牵绊表随包发布，直接从 www 根目录取（桌面端由主进程读 db 目录）
          try {
            const resp = await fetch("./db/event_bond_bonus.json", { cache: "no-store" });
            if (!resp.ok) return [];
            const data = await resp.json();
            if (Array.isArray(data)) return data;
            if (data && Array.isArray(data.events)) return data.events;
            return [];
          } catch (_) {
            return [];
          }
        },
      },
    });

    // 引擎：经 Chaquopy 跑真 CPython；协议与桌面一致（一份请求 JSON → 一份结果 JSON）
    bridge.calculate = async (payload) => {
      try {
        const cap = window.Capacitor;
        const plugin = cap && cap.Plugins && cap.Plugins.PythonEngine;
        if (!plugin) throw new Error("Python 引擎插件未注册（请重新安装 APK）");
        emitProgress("正在计算...");
        const res = await plugin.calculate({ requestJson: JSON.stringify(payload) });
        const out = JSON.parse((res && res.resultJson) || "{}");
        if (out && out.status === "error") throw new Error(out.message || "计算失败");
        return out;
      } catch (err) {
        pushDiag("error", `引擎计算失败：${(err && err.message) || err}`);
        throw err;
      }
    };

    // 写操作后持久化
    const wrapped = {};
    for (const key of Object.keys(bridge)) {
      const fn = bridge[key];
      wrapped[key] = WRITE_METHODS.has(key)
        ? (...args) => {
            const out = fn(...args);
            schedulePersist();
            return out;
          }
        : fn;
    }

    realBridge = wrapped;
    emitProgress("就绪");
    pushDiag("info", "本地数据库已就绪");
  }

  init()
    .then(() => {
      for (const call of pendingCalls.splice(0)) {
        try {
          call.resolve(realBridge[call.methodName](...call.args));
        } catch (err) {
          call.reject(err);
        }
      }
    })
    .catch((err) => {
      initError = err instanceof Error ? err : new Error(String(err));
      console.error("[android-host] 初始化失败：", initError);
      pushDiag("error", "初始化失败：" + initError.message);
      for (const call of pendingCalls.splice(0)) call.reject(initError);
    });
})();
