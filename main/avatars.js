"use strict";

/**
 * 运行时补齐缺失头像（第一再临头像）
 *
 * 背景：
 * - 头像随包发布（`renderer/assets/servantface/{id}.png`，打进 app.asar，只读）；
 * - 应用内「更新数据」会拉到更新的从者，但**不会**带来图片 → 新从者没有头像；
 * - 所以更新数据后（以及界面遇到坏图时）在这里按需下载，写到**可写目录**：
 *       <运行库目录>\avatars\{id}.png
 *   放在运行库旁边的原因：更新程序会保留 db 目录，升级不会丢。
 *
 * 只下载公开图片（按从者 id 取），不上传任何用户数据。
 * 源：static.atlasacademy.io/{区域}/Faces/f_{id}0.png
 *   默认日服（数据新）；日服拿不到时退回简中服。
 */

const fs = require("fs");
const path = require("path");
const database = require("./database");
const { getDbPath } = require("./paths");
const { diagLog } = require("./diag-log");

const FACE_URL = "https://static.atlasacademy.io/{region}/Faces/f_{id}0.png";
const REGIONS = ["JP", "CN"];
const TIMEOUT_MS = 15000;
const UA = "FGOBondApp/0.1";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** 运行时头像目录（可写，随运行库保留） */
function avatarDir() {
  return path.join(path.dirname(getDbPath()), "avatars");
}

function avatarFile(id) {
  return path.join(avatarDir(), `${id}.png`);
}

/** 包内自带头像目录（在 app.asar 里，只读） */
function packedAvatarFile(id) {
  return path.join(__dirname, "..", "renderer", "assets", "servantface", `${id}.png`);
}

function isServantId(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

/** 包内或运行时目录里已经有这张头像吗 */
function hasAvatar(id) {
  if (!isServantId(id)) return false;
  const key = String(id);
  try {
    if (fs.existsSync(avatarFile(key))) return true;
  } catch (_) {
    // ignore
  }
  try {
    return fs.existsSync(packedAvatarFile(key));
  } catch (_) {
    return false;
  }
}

/** 本地库里全部从者 id（读不到就返回空表，绝不抛错） */
function listServantIds() {
  let db = null;
  try {
    db = database.open();
    return database
      .all(db, "SELECT id FROM servants")
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (err) {
    diagLog(`读取从者清单失败（补齐头像跳过）：${(err && err.message) || err}`);
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {
        // ignore
      }
    }
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows 下目标已存在时 rename 会失败，退回直接覆盖
    fs.writeFileSync(file, data);
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_) {
      // ignore
    }
  }
}

/** 下载一张头像；日服优先，失败退回简中服 */
async function downloadFace(id) {
  let lastError = null;
  for (const region of REGIONS) {
    const url = FACE_URL.replace("{region}", region).replace("{id}", String(id));
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = new Error(`${region} HTTP ${res.status}`);
        continue;
      }
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length < 8 || !data.subarray(0, 4).equals(PNG_MAGIC)) {
        lastError = new Error(`${region} 返回的不是 PNG`);
        continue;
      }
      return { data, region };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("下载失败");
}

/** 读本地已有头像为 data URL（运行时目录优先，其次包内） */
function localAvatarDataUrl(id) {
  const key = String(id);
  for (const file of [avatarFile(key), packedAvatarFile(key)]) {
    try {
      const data = fs.readFileSync(file);
      if (data.length) return `data:image/png;base64,${data.toString("base64")}`;
    } catch (_) {
      // 这个位置没有，试下一个
    }
  }
  return null;
}

/**
 * 批量补齐：默认补全库里所有「包内和运行时目录都没有」的从者。
 * 单张失败不影响其它；全程不抛错（失败只记录并返回）。
 */
async function ensureAvatars({ ids, onProgress } = {}) {
  const all = Array.isArray(ids) && ids.length ? ids.map(Number) : listServantIds();
  const valid = all.filter((id) => Number.isFinite(id) && id > 0);
  const missing = valid.filter((id) => !hasAvatar(id));
  const result = { total: valid.length, missing: missing.length, fetched: 0, failed: [], regions: {} };
  if (!missing.length) return result;

  if (typeof onProgress === "function") onProgress(0, missing.length);

  for (let i = 0; i < missing.length; i += 1) {
    const id = missing[i];
    try {
      const { data, region } = await downloadFace(id);
      writeAtomic(avatarFile(id), data);
      result.fetched += 1;
      result.regions[region] = (result.regions[region] || 0) + 1;
    } catch (err) {
      const message = (err && err.message) || String(err);
      result.failed.push({ id, error: message });
      diagLog(`头像下载失败 ${id}：${message}`);
    }
    if (typeof onProgress === "function") {
      onProgress(result.fetched + result.failed.length, missing.length);
    }
  }

  diagLog(
    `补齐缺失头像：缺 ${result.missing}，成功 ${result.fetched}，失败 ${result.failed.length}` +
      (result.failed.length ? `（失败 id：${result.failed.map((f) => f.id).join(",")}）` : "")
  );
  return result;
}

/**
 * 取一张头像的数据（界面遇到坏图时调用）：
 * 本地有（运行时目录 / 包内）→ 直接返回；没有 → 现下，顺手落盘。
 * 返回 { ok, dataUrl?, cached?, error? }，不抛错。
 */
async function getAvatarData(id) {
  if (!isServantId(id)) return { ok: false, error: "无效的从者 ID" };
  const key = String(id);

  const cached = localAvatarDataUrl(key);
  if (cached) return { ok: true, dataUrl: cached, cached: true };

  try {
    const { data } = await downloadFace(key);
    try {
      writeAtomic(avatarFile(key), data);
    } catch (err) {
      diagLog(`头像落盘失败 ${key}：${(err && err.message) || err}`);
    }
    return { ok: true, dataUrl: `data:image/png;base64,${data.toString("base64")}`, cached: false };
  } catch (err) {
    const message = (err && err.message) || String(err);
    diagLog(`头像获取失败 ${key}：${message}`);
    return { ok: false, error: message };
  }
}

module.exports = {
  avatarDir,
  avatarFile,
  hasAvatar,
  listServantIds,
  ensureAvatars,
  getAvatarData,
};
