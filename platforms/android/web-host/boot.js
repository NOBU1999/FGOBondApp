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
    "getCrownServants",
    "saveCrownServants",
    "listCustomCrafts",
    "saveCustomCrafts",
    "listUserTeams",
    "saveUserTeam",
    "renameUserTeam",
    "deleteUserTeam",
    "getUserTeamResult",
    "saveUserTeamResult",
    "deleteUserTeamResult",
    // 个人数据导出 / 导入（跨端迁移）
    "exportPersonalData",
    "importPersonalData",
    "getTeamMemory",
    "saveTeamMemory",
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
  // 计算引擎：TypeScript Worker（与桌面同一份代码）—— **没有回退**
  //   · Worker 的 sql.js / wasm 从随包 `vendor/sqljs/` 取，库字节由主线程 `db.export()` 交过去
  //   · 初始化失败就**如实报错**并拒绝计算（没有别的引擎可退：
  //     v0.3.1 起仓库里已经没有 Python 引擎，调不到的兜底只会把病因盖成"请重新安装"）
  // -------------------------------------------------------------------------
  const TS_ENGINE_ENTRY = "./platforms/android/web-host/engine-worker.js";
  let tsEngineWorker = null;
  let tsEngineReady = null; // Promise：Worker 报 ready 之后 resolve
  let tsEngineFailure = null; // 初始化失败的原因（一旦失败就不再尝试）
  let tsPending = null; // { resolve, reject }：同一时刻只允许一个计算
  let tsQueue = Promise.resolve();

  /** 建 Worker 并等它把 sql.js + 引擎都加载完（失败只 reject，不重试） */
  function ensureTsEngine() {
    if (tsEngineReady) return tsEngineReady;
    tsEngineReady = new Promise((resolve, reject) => {
      let settled = false;
      const settleOk = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      const settleFail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      let worker;
      try {
        worker = new Worker(TS_ENGINE_ENTRY);
      } catch (err) {
        settleFail(err);
        return;
      }
      tsEngineWorker = worker;
      worker.onerror = (event) => {
        const message = (event && event.message) || "TS 引擎 Worker 出错";
        pushDiag("error", "TS 引擎 Worker 出错：" + message);
        settleFail(new Error(message));
        settlePending(new Error(message));
      };
      worker.onmessage = (event) => {
        const msg = event && event.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") {
          pushDiag("info", "TS 引擎 Worker 已就绪");
          settleOk();
          return;
        }
        if (msg.type === "progress") {
          emitProgress(msg.line);
          return;
        }
        if (msg.type === "result") {
          settlePending(null, msg.payload);
          return;
        }
        if (msg.type === "error") {
          const err = new Error(msg.message || "计算失败");
          if (!settled) settleFail(err);
          settlePending(err);
        }
      };
      // 15 秒还没 ready 就当不可用（真机上几千毫秒都可能，别设太紧）
      setTimeout(() => settleFail(new Error("TS 引擎 Worker 启动超时")), 15000);
    });
    return tsEngineReady;
  }

  function settlePending(err, payload) {
    const pending = tsPending;
    tsPending = null;
    if (!pending) return;
    if (err) pending.reject(err);
    else pending.resolve(payload);
  }

  /** 一次计算：库字节交过去，进度走 emitProgress，结果原样返回（与桌面同结构） */
  async function tsCalculate(payload) {
    await ensureTsEngine();
    // 串行化：界面会连着调（主结果 + 各个种子预设），Worker 侧一次只算一个
    const run = tsQueue.then(
      () =>
        new Promise((resolve, reject) => {
          // 引擎只读静态数据：直接给随包 game.db 的一份副本（不再把 15MB 的整库导出来）
          const gameBytes = window.__fgoGameBytes;
          if (!gameBytes) {
            reject(new Error("静态数据还没就绪"));
            return;
          }
          const bytes = new Uint8Array(gameBytes.length);
          bytes.set(gameBytes);
          tsPending = { resolve, reject };
          try {
            tsEngineWorker.postMessage(
              { type: "calc", dbBytes: bytes.buffer, request: payload },
              [bytes.buffer],
            );
          } catch (err) {
            tsPending = null;
            reject(err);
          }
        }),
    );
    tsQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 取消：TS Worker 走"置标志"（引擎让步时读到） */
  function cancelTsEngine() {
    if (!tsEngineWorker || !tsPending) return false;
    try {
      tsEngineWorker.postMessage({ type: "cancel" });
      return true;
    } catch (_) {
      return false;
    }
  }

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
    // TS 引擎：置标志，引擎在搜索循环里让步时读到 ⇒ 超级模式体面收尾、普通模式抛「已取消」
    if (cancelTsEngine()) return Promise.resolve({ ok: true, graceful: true });
    return Promise.resolve({ ok: true });
  };
  api.checkDataUpdate = () =>
    Promise.reject(new Error("安卓版不支持联网检查更新；数据随安装包发布（更新请下载新版 APK）"));
  api.updateData = () =>
    Promise.reject(new Error("安卓版不支持联网更新数据；数据随安装包发布（更新请下载新版 APK）"));
  api.resetStaticData = () =>
    Promise.reject(new Error("安卓版暂不支持重置静态数据；可卸载重装以恢复初始数据"));
  // ---- 检查软件更新：安卓本来就没有桌面那套更新器（更新＝覆盖安装 APK），只查最新版本号并给链接 ----
  const UPDATE_SOURCES = [
    {
      key: "jsdelivr",
      label: "jsDelivr CDN",
      url: "https://fastly.jsdelivr.net/gh/NOBU1999/FGOBondApp@main/package.json",
      kind: "package",
    },
    {
      key: "github",
      label: "GitHub Releases",
      url: "https://api.github.com/repos/NOBU1999/FGOBondApp/releases/latest",
      kind: "github",
    },
    {
      key: "tuna",
      label: "清华 GitHub 镜像",
      url: "https://mirrors.tuna.tsinghua.edu.cn/github-release/NOBU1999/FGOBondApp/LatestRelease/",
      kind: "html",
    },
  ];
  const GITHUB_RELEASES_URL = "https://github.com/NOBU1999/FGOBondApp/releases";
  const BILIBILI_DYNAMIC_URL = "https://space.bilibili.com/431124482/dynamic";

  function parseVersion(text) {
    const m = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? { raw: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
  }

  function versionNewer(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return false;
    for (let i = 0; i < 3; i += 1) {
      if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i];
    }
    return false;
  }

  /**
   * 当前版本号。安卓没有 version.json、也没有 Electron 的 app.getVersion()，
   * 只能用打包时注入的 `window.__FGO_APP_VERSION`（形如 `0.3.1+261025`，尾巴是构建日期）。
   * ⚠️ 2026-10-27 修：这里原来读的是 `api.info.version`，而 `api.info` 从来没被赋值过
   * ⇒ 「检查更新」一直显示 V0.0.0。
   */
  function currentAppVersion() {
    const raw = String((typeof window !== "undefined" && window.__FGO_APP_VERSION) || "").trim();
    const v = parseVersion(raw);
    if (v) return v.raw; // "0.3.1+261025" → "0.3.1"
    return raw || "0.0.0";
  }

  api.checkAppUpdate = async () => {
    const current = currentAppVersion();
    const checks = [];
    let found = null;
    for (const source of UPDATE_SOURCES) {
      try {
        const resp = await fetch(source.url, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        if (source.kind === "package") {
          const data = JSON.parse(text);
          const v = parseVersion(data.version);
          if (!v) throw new Error("没有版本号");
          checks.push({ key: source.key, label: source.label, ok: true, version: v.raw });
          if (!found) found = { version: v.raw, releaseUrl: GITHUB_RELEASES_URL, notes: "", source };
        } else if (source.kind === "github") {
          const data = JSON.parse(text);
          const v = parseVersion(data.tag_name || data.name);
          if (!v) throw new Error("没有版本号");
          checks.push({ key: source.key, label: source.label, ok: true, version: v.raw });
          if (!found) {
            found = {
              version: v.raw,
              releaseUrl: data.html_url || GITHUB_RELEASES_URL,
              notes: String(data.body || "").slice(0, 500),
              source,
            };
          }
        } else {
          const v = parseVersion(text);
          if (!v) throw new Error("镜像页里没有版本号");
          checks.push({ key: source.key, label: source.label, ok: true, version: v.raw });
          if (!found) found = { version: v.raw, releaseUrl: GITHUB_RELEASES_URL, notes: "", source };
        }
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
        githubUrl: GITHUB_RELEASES_URL,
        bilibiliUrl: BILIBILI_DYNAMIC_URL,
      };
    }
    return {
      ok: true,
      current,
      latest: found.version,
      hasUpdate: versionNewer(found.version, current),
      source: { key: found.source.key, label: found.source.label },
      releaseUrl: found.releaseUrl || GITHUB_RELEASES_URL,
      notes: found.notes || "",
      checks,
      githubUrl: GITHUB_RELEASES_URL,
      bilibiliUrl: BILIBILI_DYNAMIC_URL,
      androidNote: "安卓版请下载新版 APK 覆盖安装（个人数据保留）",
    };
  };
  // 用系统浏览器打开链接（安卓走 WebView 的外链处理）
  api.openExternal = async (url) => {
    const target = String(url || "");
    if (!/^https:\/\//i.test(target)) throw new Error("不允许打开的链接");
    window.open(target, "_blank");
    return { ok: true, url: target };
  };
  // ---- 导出文本文件（导出 JSON / 反馈摘要） ----
  //   安卓 WebView 不处理 <a download>，所以「点了没反应」——这里改成：
  //   ① 写进系统的「文档」目录（文件管理器能看到）；② 没权限就落到应用数据目录；
  //   ③ 都不行就复制到剪贴板，保证一定有反馈。
  api.saveTextFile = async (payload) => {
    const rawName = String((payload && payload.name) || "export.json");
    const name = rawName.replace(/[\\/:*?"<>|\s]+/g, "_");
    const text = String((payload && payload.text) ?? "");
    const fs = getFilesystem();
    if (fs) {
      try {
        const r = await fs.writeFile({
          path: name,
          data: text,
          directory: "DOCUMENTS",
          encoding: "utf8",
          recursive: true,
        });
        return { ok: true, path: "文档/" + name, uri: (r && r.uri) || "" };
      } catch (_) {
        /* 没有存储权限时继续往下走 */
      }
      try {
        const r = await fs.writeFile({
          path: name,
          data: text,
          directory: "DATA",
          encoding: "utf8",
          recursive: true,
        });
        return { ok: true, path: "应用数据目录/" + name, uri: (r && r.uri) || "", fallback: true };
      } catch (_) {
        /* 继续往下走 */
      }
    }
    try {
      await api.copyText(text);
      return { ok: true, copied: true, path: "剪贴板" };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
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
  // v0.3.8：两个库
  //   随包 game.db      静态数据（从者 / 礼装 / 特性 / 灵衣）—— APK 里只读，换版自然跟着换
  //   DATA/fgo_data.db  个人数据（账号 / Box / 排除 / 冠位名单 / 预设 / 自定义礼装）—— 只写这一个
  // 两侧口径一致（桌面见 shared/storage/schema.mjs）：包内的静态数据永远优先，
  // 个人数据只存在自己的小文件里 ⇒ 覆盖安装不可能丢 Box，也不用再「搬个人表」。
  const DB_FILE_IN_APP = "fgo_data.db";
  const GAME_DB_FILE_IN_APP = "game.db";
  const DB_FILE_IN_PACKAGE = "./db/game.db";
  // 老版本单库里同时也存着静态数据：拆分时留一份原始备份（只留一次）
  const LEGACY_BACKUP_FILE = "fgo_data-before-0.3.8.db";
  const USER_META_KEYS = [
    "active_account_id",
    "server_region",
    "generic_bond_participation",
    "non_participating_craft_ids",
  ];
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
    "saveCrownServants",
    "saveCustomCrafts",
    "saveUserTeam",
    "renameUserTeam",
    "deleteUserTeam",
    "saveUserTeamResult",
    "deleteUserTeamResult",
    // 编队记忆（写库 + 落盘）
    "saveTeamMemory",
    // 导入个人数据 = 整份替换，必须立刻落盘（不防抖）
    "importPersonalData",
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

  /** 读一个 app_meta 值；读不到返回空串（老库没有这个键也算"没有版本"） */
  function readMetaValue(db, key) {
    try {
      const res = db.exec(
        `SELECT value FROM app_meta WHERE key = '${String(key).replace(/'/g, "''")}'`
      );
      const row = res && res[0] && res[0].values && res[0].values[0];
      const value = row && row[0];
      return value === undefined || value === null ? "" : String(value);
    } catch (_) {
      return "";
    }
  }

  /** 读单个标量值（sql.js 的 exec 返回 [ { columns, values } ]） */
  function oneValue(db, sql) {
    const res = db.exec(sql);
    const row = res && res[0] && res[0].values && res[0].values[0];
    return row ? row[0] : null;
  }

  function staticTableExists(db, table) {
    try {
      const res = db.exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${String(table).replace(/'/g, "''")}'`
      );
      return !!(res && res[0] && res[0].values && res[0].values.length);
    } catch (_) {
      return false;
    }
  }

  function listTableColumns(db, table) {
    try {
      const res = db.exec('PRAGMA table_info("' + table + '")');
      const rows = (res && res[0] && res[0].values) || [];
      return rows.map((row) => String(row[1]));
    } catch (_) {
      return [];
    }
  }

  function readTableRows(db, table, columns) {
    const cols = columns || listTableColumns(db, table);
    if (!cols.length) return { columns: [], rows: [] };
    // ⚠️ 必须按列名取：`SELECT *` 在「源库列比目标库多」时会让插入的行宽对不上
    //    （老单库的 user_teams 有 result_id，新结构由 ALTER 加的列顺序也不一样）
    const list = cols.map((c) => '"' + c + '"').join(", ");
    const res = db.exec("SELECT " + list + ' FROM main."' + table + '"');
    return { columns: cols, rows: (res && res[0] && res[0].values) || [] };
  }

  function insertTableRows(db, table, data) {
    const rows = (data && data.rows) || [];
    if (!rows.length) return;
    const columns = data.columns;
    const placeholders = columns.map(() => "?").join(", ");
    const stmt = db.prepare(
      'INSERT INTO main."' + table + '" (' + columns.map((c) => '"' + c + '"').join(", ") +
        ") VALUES (" + placeholders + ")"
    );
    try {
      for (const row of rows) stmt.run(row);
    } finally {
      if (stmt && typeof stmt.free === "function") stmt.free();
    }
  }

  /** 把旧库的个人数据按列名搬进新库（列取交集，兼容旧版本缺列） */
  function carryUserTables(target, source, tables) {
    let carried = 0;
    for (const table of tables) {
      if (!staticTableExists(target, table) || !staticTableExists(source, table)) continue;
      const targetCols = listTableColumns(target, table);
      const sourceCols = listTableColumns(source, table);
      const shared = targetCols.filter((c) => sourceCols.indexOf(c) >= 0);
      if (!shared.length) continue;
      try {
        const payload = readTableRows(source, table, shared);
        if (!payload.rows.length) continue;
        target.exec('BEGIN');
        try {
          target.exec('DELETE FROM main."' + table + '"');
          insertTableRows(target, table, payload);
          target.exec("COMMIT");
        } catch (err) {
          target.exec("ROLLBACK");
          throw err;
        }
        carried += payload.rows.length;
      } catch (err) {
        pushDiag("warn", `静态数据刷新：搬移 ${table} 失败（已跳过该表）：${err && err.message ? err.message : err}`);
      }
    }
    // 修正 AUTOINCREMENT 序列，避免搬运后新插入的 id 冲突
    try {
      for (const table of tables) {
        if (!staticTableExists(target, table)) continue;
        const res = target.exec('SELECT COALESCE(MAX(rowid), 0) FROM main."' + table + '"');
        const maxRowId = Number((res && res[0] && res[0].values && res[0].values[0] && res[0].values[0][0]) || 0);
        target.exec("DELETE FROM main.sqlite_sequence WHERE name = '" + table + "'");
        target.exec("INSERT INTO main.sqlite_sequence(name, seq) VALUES('" + table + "', " + maxRowId + ")");
      }
    } catch (_) {
      /* 没有 sqlite_sequence 时忽略 */
    }
    return carried;
  }

  /** 读随包（assets）里的静态库原始字节 */
  async function loadPackageBytes() {
    const resp = await fetch(DB_FILE_IN_PACKAGE);
    if (!resp.ok) throw new Error("读不到随包数据库：" + DB_FILE_IN_PACKAGE);
    return new Uint8Array(await resp.arrayBuffer());
  }

  /** 读应用数据目录里的个人库（没有就是首次运行） */
  async function loadPersonalBytes() {
    const fs = getFilesystem();
    if (!fs) return null;
    try {
      const res = await fs.readFile({ path: DB_FILE_IN_APP, directory: "DATA" });
      const data = res && res.data;
      if (typeof data === "string") return base64ToBytes(data);
      if (data && typeof data.text === "function") return new Uint8Array(await data.arrayBuffer());
      return null;
    } catch (_) {
      return null;
    }
  }

  /** 老单库只备份一次（拆分前那份，里面同时有静态与个人数据） */
  async function backupLegacyOnce(bytes) {
    const fs = getFilesystem();
    if (!fs) return;
    try {
      const res = await fs.readFile({ path: LEGACY_BACKUP_FILE, directory: "DATA" });
      if (res && res.data) return; // 已经备份过
    } catch (_) {
      /* 没有备份文件 → 下面写一份 */
    }
    try {
      await fs.writeFile({
        path: LEGACY_BACKUP_FILE,
        directory: "DATA",
        data: bytesToBase64(bytes),
        recursive: true,
      });
      pushDiag("info", "已备份老版本数据库：" + LEGACY_BACKUP_FILE);
    } catch (err) {
      pushDiag("warn", "备份老版本数据库失败（继续）：" + ((err && err.message) || err));
    }
  }

  /**
   * 组装运行时数据库：以随包 game.db 为基底（静态数据永远用包内那份），
   * 再把个人库里的个人表搬进来。老单库只搬个人表，静态部分直接丢弃。
   */
  async function buildRuntimeDb(SQL, schema, gameBytes, personalBytes) {
    const db = new SQL.Database(gameBytes);
    db.exec(schema.PERSONAL_DDL);
    if (!personalBytes) return db;
    const pdb = new SQL.Database(personalBytes);
    try {
      if (staticTableExists(pdb, "servants")) {
        // 0.3.7 及以前的单库：静态部分交给随包 game.db，这里只取个人数据
        await backupLegacyOnce(personalBytes);
      }
      carryUserTables(db, pdb, schema.USER_TABLES);
      for (const key of schema.USER_META_KEYS) {
        const value = readMetaValue(pdb, key);
        if (!value) continue;
        try {
          db.exec(
            "INSERT OR REPLACE INTO main.app_meta(key, value) VALUES('" + key + "', '" +
              String(value).replace(/'/g, "''") + "')"
          );
        } catch (_) {
          /* 该键不存在时忽略 */
        }
      }
    } finally {
      try {
        pdb.close();
      } catch (_) {
        /* ignore */
      }
    }
    return db;
  }

  /** 从运行时库抽出「只有个人数据」的那一份（保存时写它，文件很小） */
  function personalBytesFrom(db, schema) {
    const SQL = window.__fgoSql;
    if (!SQL) throw new Error("sql.js 还没就绪");
    const out = new SQL.Database();
    try {
      out.exec(schema.PERSONAL_DDL);
      carryUserTables(out, db, schema.USER_TABLES);
      for (const key of schema.USER_META_KEYS) {
        const value = readMetaValue(db, key);
        if (!value) continue;
        try {
          out.exec(
            "INSERT OR REPLACE INTO main.app_meta(key, value) VALUES('" + key + "', '" +
              String(value).replace(/'/g, "''") + "')"
          );
        } catch (_) {
          /* 忽略 */
        }
      }
      return out.export();
    } finally {
      try {
        out.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** 把内存库写回应用数据目录（只写个人库；静态数据在 APK 里，不需要写） */
  let saveTimer = null;
  async function persistNow(dbOverride) {
    const fs = getFilesystem();
    const db = dbOverride || window.__fgoDb;
    const schema = window.__fgoSchema;
    if (!fs || !db || !schema) return { ok: false };
    try {
      const bytes = personalBytesFrom(db, schema);
      await fs.writeFile({
        path: DB_FILE_IN_APP,
        directory: "DATA",
        data: bytesToBase64(bytes),
        recursive: true,
      });
      return { ok: true, size: bytes.length };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      pushDiag("warn", "保存本地数据失败：" + message);
      return { ok: false, error: message };
    }
  }

  /** 导入个人数据前留一份当前库（同目录，覆盖上一次的） */
  async function backupPersonalBeforeImport() {
    const fs = getFilesystem();
    const db = window.__fgoDb;
    const schema = window.__fgoSchema;
    if (!fs || !db || !schema) return;
    const bytes = personalBytesFrom(db, schema);
    await fs.writeFile({
      path: "fgo_data-before-import.db",
      directory: "DATA",
      data: bytesToBase64(bytes),
      recursive: true,
    });
  }

  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const res = await persistNow();
      if (res && res.ok === false && res.error) emitProgress("保存本地数据失败：" + res.error);
    }, 600);
  }

  /** 初始化/结构升级后立刻落盘（不等防抖） */
  function schedulePersistNow(dbOverride) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return persistNow(dbOverride);
  }

  async function init() {
    if (typeof window.initSqlJs !== "function") {
      throw new Error("sql.js 未加载（vendor/sqljs/sql-wasm.js 缺失）");
    }
    emitProgress("正在载入本地数据库...");
    pushDiag("info", `开始载入本地数据库（v${window.__FGO_APP_VERSION || "?"}）`);
    const SQL = await window.initSqlJs({ locateFile: (file) => "./vendor/sqljs/" + file });
    // 结构定义与桌面共用一份（shared/storage/schema.mjs）
    const schema = await import("../../../shared/storage/schema.mjs");
    const gameBytes = await loadPackageBytes();
    const personalBytes = await loadPersonalBytes();
    const db = await buildRuntimeDb(SQL, schema, gameBytes, personalBytes);
    window.__fgoDb = db;
    window.__fgoSql = SQL;
    // 引擎只读静态数据：直接拿随包 game.db 的字节，不再导出整库
    window.__fgoGameBytes = gameBytes;
    window.__fgoSchema = schema;
    window.__fgoGameDbFile = GAME_DB_FILE_IN_APP;
    // 首次运行 / 老库拆分 / 结构升级：立刻落一份「只有个人数据」的库
    await schedulePersistNow(db);

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

    pushDiag("info", "计算引擎：TypeScript Worker");

    // 引擎：只有 TS Worker 一条路（与桌面同一份代码）。初始化失败就抛真实原因，不兜底。
    bridge.calculate = async (payload) => {
      if (!tsEngineFailure) {
        try {
          await ensureTsEngine();
        } catch (err) {
          tsEngineFailure = (err && err.message) || String(err);
          pushDiag("error", `计算引擎初始化失败：${tsEngineFailure}`);
        }
      }
      if (tsEngineFailure) {
        throw new Error(`计算引擎不可用（${tsEngineFailure}）。请升级到新版，或卸载后重新安装安装包。`);
      }
      emitProgress("正在计算...");
      try {
        return await tsCalculate(payload);
      } catch (err) {
        pushDiag("error", `引擎计算失败：${(err && err.message) || err}`);
        throw err;
      }
    };

    // 写操作后持久化
    const wrapped = {};
    for (const key of Object.keys(bridge)) {
      const fn = bridge[key];
      if (key === "importPersonalData") {
        // 导入前先留一份当前个人库（导错了还能换回来），导入后立刻落盘
        wrapped[key] = async (...args) => {
          try {
            await backupPersonalBeforeImport();
          } catch (err) {
            pushDiag("warn", "导入前备份失败（继续导入）：" + ((err && err.message) || err));
          }
          const out = fn(...args);
          const res = await schedulePersistNow();
          if (res && res.ok === false) {
            pushDiag("warn", "导入后保存失败：" + (res.error || "未知原因"));
          }
          return out;
        };
        continue;
      }
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
