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
  api.cancelEngine = () => Promise.resolve({ ok: true });
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
        emitProgress("保存本地数据失败：" + (err && err.message ? err.message : err));
      }
    }, 600);
  }

  async function init() {
    if (typeof window.initSqlJs !== "function") {
      throw new Error("sql.js 未加载（vendor/sqljs/sql-wasm.js 缺失）");
    }
    emitProgress("正在载入本地数据库...");
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
        getEventBondBonuses: () => [],
      },
    });

    // 引擎：阶段 5.4 接入 Chaquopy 后替换这里
    bridge.calculate = () =>
      Promise.reject(new Error("计算引擎尚未接入（下一步：Chaquopy）"));

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
      for (const call of pendingCalls.splice(0)) call.reject(initError);
    });
})();
