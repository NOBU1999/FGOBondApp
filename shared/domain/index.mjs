/**
 * 共用领域层的组装入口。
 *
 * 用法（宿主侧）：
 *   const { createDomain } = require("../shared/domain/index.mjs");   // CJS 宿主也可加载 ESM
 *   const domain = createDomain({ sql, codec });
 *   domain.accounts.listAccounts();
 *   domain.box.importCaptureContent(text, accountId);
 *   domain.staticData.listServants("jp");
 *
 * 约定：
 * - 领域模块之间只通过显式依赖传递（例如 box / exclusions 依赖 accounts），不从全局取东西。
 * - 平台能力（base64 解码、剪贴板、时间…）一律通过注入的端口传入，不直接调用 Node / 浏览器 API。
 *   端口清单见 shared/domain/README.md。
 */

import { createMetaDomain } from "./meta.mjs";
import { createAccountsDomain } from "./accounts.mjs";
import { createBoxDomain } from "./box.mjs";
import { createExclusionsDomain } from "./exclusions.mjs";
import { createCustomCraftsDomain } from "./custom-crafts.mjs";
import { createTeamsDomain } from "./teams.mjs";
import { createStaticDataDomain } from "./static-data.mjs";

export function createDomain({ sql, codec }) {
  if (!sql) throw new Error("createDomain 需要注入 sql 端口（见 shared/storage/sql-port.md）");
  if (!codec || typeof codec.decodeBase64ToUtf8 !== "function") {
    throw new Error("createDomain 需要注入 codec.decodeBase64ToUtf8（见 shared/domain/README.md）");
  }

  const meta = createMetaDomain({ sql });
  const accounts = createAccountsDomain({ sql, meta });
  const box = createBoxDomain({ sql, accounts, codec });
  const exclusions = createExclusionsDomain({ sql, accounts });
  const customCrafts = createCustomCraftsDomain({ sql });
  const teams = createTeamsDomain({ sql });
  const staticData = createStaticDataDomain({ sql });

  return { meta, accounts, box, exclusions, customCrafts, teams, staticData };
}
