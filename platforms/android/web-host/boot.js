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
  api.checkDataUpdate = () =>
    Promise.reject(new Error("安卓版不支持联网检查更新；数据随安装包发布（更新请下载新版 APK）"));
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

  // 供电脑侧自测（.temp/android-boot-e2e.cjs / android-boot-refresh-e2e.cjs）直接调用，
  // 免去"造一个老版本 APK 再覆盖安装"才能测到这条路径。函数体在下面定义（函数声明会提升）。
  window.__fgoRefreshStaticDataIfNewer = (SQL, persistBytes, packageBytes) =>
    refreshStaticDataIfNewer(SQL, persistBytes, packageBytes);

  // ---- 异步初始化 ----
  const DB_FILE_IN_APP = "fgo_data.db";
  const DB_FILE_IN_PACKAGE = "./db/fgo_data.db";
  // 静态数据随包刷新（v0.1.14）：随包库比本地库新时，只换「从者/礼装」这些静态表，
  // 个人数据（账号 / Box / 排除 / 预设 / 自定义礼装）原样搬过去。
  // 版本以 app_meta.updated_at 为准（桌面端 main/runtime-db.js 用的是同一套判据）。
  const STATIC_VERSION_KEY = "updated_at";
  const USER_META_KEYS = [
    "active_account_id",
    "server_region",
    "generic_bond_participation",
    "non_participating_craft_ids",
  ];
  // 需要随包刷新的静态表：以随包库为准整表替换，其余表（含用户表）不动
  const STATIC_TABLES = [
    "servants",
    "servant_stage_traits",
    "servant_stage_traits_cn",
    "crafts",
    "servant_costumes",
    "servant_costume_traits",
    "servant_costume_traits_cn",
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
    const res = db.exec('SELECT * FROM main."' + table + '"');
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

  /**
   * 老库补列：与桌面端 main/database.js 的 ensureSchema 保持一致。
   * 老用户覆盖安装时，本地库是旧结构，缺列会让「读预设」这类查询直接抛错。
   * 每列都单独 try（列已存在时 SQLite 会报错，忽略即可）。
   */
  function migrateUserTableColumns(db) {
    const additions = [
      ["user_teams", "quality_mode", "TEXT DEFAULT 'balanced'"],
      ["user_teams", "neighborhood", "TEXT DEFAULT 'standard'"],
      ["user_teams", "search_order", "TEXT DEFAULT 'craft'"],
      ["user_teams", "support_position", "TEXT DEFAULT 'front_right'"],
      ["user_teams", "support_second_craft_id", "INTEGER"],
      ["user_teams", "mode", "TEXT DEFAULT 'normal'"],
      ["user_teams", "crown_class", "TEXT DEFAULT 'all'"],
      ["user_teams", "crown_positions", "TEXT"],
      ["user_teams", "base_bond", "REAL DEFAULT 0"],
      ["user_box", "aura_bonus", "REAL DEFAULT 0"],
      ["user_box", "bond_rank", "INTEGER DEFAULT 0"],
      ["user_box", "bond_max_rank", "INTEGER DEFAULT 0"],
    ];
    let added = 0;
    for (const [table, column, ddl] of additions) {
      if (!staticTableExists(db, table)) continue;
      try {
        db.exec(`ALTER TABLE main."${table}" ADD COLUMN ${column} ${ddl}`);
        added += 1;
      } catch (_) {
        /* 列已存在 */
      }
    }
    if (added) pushDiag("info", `老库补列：新增 ${added} 个字段`);
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

  /**
   * 静态数据指纹（与 Python `static_data_revision()`、`scripts/make_seed.cjs` 必须算出同一个值）：
   * 各静态表行数 + updated_at。
   * 为什么要它：`updated_at` 没变但静态数据内容变了（例如补了新的 app_meta 键）时，
   * 只比 updated_at 会漏刷新 —— 简中服「未实装从者/礼装」名单就是这么漏掉的。
   */
  function staticDataRevision(db) {
    const parts = [];
    for (const table of STATIC_TABLES) {
      let count = -1;
      try {
        count = Number(oneValue(db, 'SELECT COUNT(*) FROM main."' + table + '"') || 0);
      } catch (_) {
        /* 表不存在 */
      }
      parts.push(table + "=" + count);
    }
    parts.push("updated_at=" + (readMetaValue(db, "updated_at") || ""));
    return parts.join("|");
  }

  /**
   * 随包静态数据比本地新就刷新本地库：
   *   以随包库为基底，搬入旧库的个人表 + 用户偏好键。
   * 返回 { status, newBytes }；任何一步失败都返回 failed 并让调用方沿用旧库。
   */
  function refreshStaticDataIfNewer(SQL, persistBytes, packageBytes) {
    if (!persistBytes || !packageBytes) return { status: "skip" };
    let runtimeRoot = null;
    let packageDb = null;
    let next = null;
    try {
      runtimeRoot = new SQL.Database(persistBytes);
      const runtimeVersion = readMetaValue(runtimeRoot, STATIC_VERSION_KEY);
      const runtimeRevision = readMetaValue(runtimeRoot, "static_revision");
      packageDb = new SQL.Database(packageBytes);
      const packageVersion = readMetaValue(packageDb, STATIC_VERSION_KEY);
      const packageRevision = readMetaValue(packageDb, "static_revision");

      // 随包库没有版本 → 不动；用户自己更新过（本地更新）→ 不回退
      if (!packageVersion || (runtimeVersion && packageVersion < runtimeVersion)) {
        return { status: "keep", runtimeVersion, packageVersion };
      }
      let reason = "";
      if (!runtimeVersion) {
        reason = "本地库无版本号";
      } else if (packageVersion > runtimeVersion) {
        reason = "随包数据版本更新";
      } else if (packageRevision && runtimeRevision && packageRevision !== runtimeRevision) {
        reason = "静态数据已更新（指纹不同）";
      } else if (packageRevision && !runtimeRevision) {
        reason = "本地库缺少静态数据指纹（旧版本库）";
      } else if (!packageRevision && !packageVersion) {
        return { status: "keep", runtimeVersion, packageVersion };
      } else {
        return { status: "keep", runtimeVersion, packageVersion };
      }

      next = new SQL.Database(packageBytes);
      const carried = carryUserTables(
        next,
        runtimeRoot,
        ["accounts", "user_box", "user_exclusions", "user_teams", "custom_crafts"]
      );
      for (const key of USER_META_KEYS) {
        const value = readMetaValue(runtimeRoot, key);
        if (!value) continue;
        try {
          next.exec(
            "INSERT INTO main.app_meta(key, value) VALUES('" + key + "', '" +
              value.replace(/'/g, "''") + "') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          );
        } catch (_) {
          /* 该键不存在时忽略 */
        }
      }

      const newBytes = next.export();
      pushDiag(
        "info",
        `随包静态数据已刷新：${runtimeVersion || "(空)"} -> ${packageVersion}` +
          `（${reason}；个人数据保留 ${carried} 行）`
      );
      emitProgress("已更新随包静态数据（Box / 预设已保留）");
      return {
        status: "refreshed",
        newBytes,
        reason,
        runtimeVersion,
        packageVersion,
        carriedUserData: carried,
      };
    } catch (err) {
      pushDiag("warn", `静态数据刷新失败（继续用本地库）：${err && err.message ? err.message : err}`);
      return { status: "failed", error: err && err.message ? err.message : String(err) };
    } finally {
      try {
        if (next) next.close();
        if (packageDb) packageDb.close();
        if (runtimeRoot) runtimeRoot.close();
      } catch (_) {
        /* 关不掉不影响主流程 */
      }
    }
  }

  /** 读随包（assets）里的那份数据库原始字节 */
  async function loadPackageBytes() {
    const resp = await fetch(DB_FILE_IN_PACKAGE);
    if (!resp.ok) throw new Error("读不到随包数据库：" + DB_FILE_IN_PACKAGE);
    return new Uint8Array(await resp.arrayBuffer());
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
    return loadPackageBytes();
  }

  /** 把内存库写回应用数据目录（累加式保存；Box 保存等操作不频繁，可接受） */
  let saveTimer = null;
  async function persistNow(dbOverride) {
    const fs = getFilesystem();
    const db = dbOverride || window.__fgoDb;
    if (!fs || !db) return { ok: false };
    try {
      const bytes = db.export();
      await fs.writeFile({
        path: DB_FILE_IN_APP,
        directory: "DATA",
        data: bytesToBase64(bytes),
        recursive: true,
      });
      return { ok: true };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      pushDiag("warn", "保存本地数据失败：" + message);
      return { ok: false, error: message };
    }
  }

  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const res = await persistNow();
      if (res && res.ok === false && res.error) emitProgress("保存本地数据失败：" + res.error);
    }, 600);
  }

  /** 静态数据刷新后立刻落盘（不等防抖），避免刷新结果没写回就退出 */
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
    const bytes = await loadDatabaseBytes();
    // 随包静态数据更新时，用随包库 + 旧库的个人数据合成新库（安卓没有联网更新数据的入口，
    // 所以换新版 APK 覆盖安装后，这一步就是把新从者/新礼装带进来的唯一机会）
    let db = new SQL.Database(bytes);
    window.__fgoDb = db;
    try {
      const packageBytes = await loadPackageBytes();
      const refreshed = refreshStaticDataIfNewer(SQL, db.export(), packageBytes);
      if (refreshed.status === "refreshed" && refreshed.newBytes) {
        try {
          db.close();
        } catch (_) {
          /* 旧的关不掉无所谓 */
        }
        db = new SQL.Database(refreshed.newBytes);
        window.__fgoDb = db;
        await schedulePersistNow(db);
      }
    } catch (err) {
      pushDiag("warn", `静态数据刷新检查失败（继续用本地库）：${err && err.message ? err.message : err}`);
    }
    // 老库补列（与桌面 main/database.js 的 ensureSchema 对齐）：安卓以前漏了这一步，
    // 老用户覆盖安装后会因为"读预设"报 no such column 而直接报错
    try {
      migrateUserTableColumns(db);
    } catch (err) {
      pushDiag("warn", `老库补列失败（继续）：${err && err.message ? err.message : err}`);
    }

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
