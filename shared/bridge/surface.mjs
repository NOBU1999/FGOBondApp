/**
 * 桥接接口的「名字清单」——各平台安装 window.fgo.* 时的唯一依据
 *
 * 分三类：
 *   - 数据方法：实现在 shared/bridge/data-bridge.mjs，名字由 BRIDGE_METHOD_NAMES 推导
 *   - 平台方法：各平台自己实现（下面 PLATFORM_METHODS；界面可能调用，名字必须对齐）
 *   - 订阅方法：不发 IPC / 不查数据，只在渲染侧登记回调（SUBSCRIBE_METHODS）
 *
 * 为什么要有这个文件：以前"方法清单"散在 4 处（preload.js、main/ipc-handlers.js、
 * platforms/android/web-host/boot.js、docs），加方法时漏一处就出事（活动牵绊表就是
 * 安卓端漏了实现）。清单一致性和界面调用都用 `npm run test:contracts` 里的 surface 套件核对。
 */

/** 平台能力：各平台自己实现（桌面 main/ipc-handlers.js，安卓 platforms/android/web-host/boot.js） */
export const PLATFORM_METHODS = Object.freeze([
  "calculate",
  "updateData",
  "resetStaticData",
  "cancelEngine",
  "copyText",
  "getAvatarData",
  "ensureAvatars",
  "getDiagnosticLog",
  "clearDiagnosticLog",
]);

/** 只做事件订阅：渲染侧本地实现（preload.js / boot.js），不走 IPC */
export const SUBSCRIBE_METHODS = Object.freeze(["onEngineProgress", "onMenuAction"]);

/**
 * 安卓端**故意不实现**的平台方法（界面必须能在缺失时优雅退化）。
 * 注意 updateData / resetStaticData 安卓是"明确报错"（有实现、给出提示），不在此列。
 */
export const ANDROID_NOT_IMPLEMENTED = Object.freeze(["ensureAvatars"]);
