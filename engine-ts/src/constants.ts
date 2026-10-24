// P2 数据层 / 求值层：常量（对应 python-engine/engine/constants.py）
// 不直接引用 `process`：网页/Worker 里没有它（平台层还没初始化时也要能取默认值）
function envOr(key: string, dflt: string): string {
  try {
    const g = globalThis as any;
    const v = g.process?.env?.[key] ?? g.__FGO_ENV__?.[key];
    return v === undefined ? dflt : String(v);
  } catch {
    return dflt;
  }
}
export const DEFAULT_REGION = envOr("FGO_REGION", "JP").toUpperCase();
export const SUPPORTED_REGIONS = ["JP", "NA", "CN", "KR", "TW"] as const;

export const STAGES = ["initial", "first", "second", "third", "fourth"] as const;
export type Stage = (typeof STAGES)[number];
export const ASCENSION_KEYS = ["0", "1", "2", "3", "4"] as const;
export const DEFAULT_STAGE: Stage = "fourth";
export const SCHEMA_VERSION = 1;
export const DEFAULT_COST_LIMIT = 114;

export const STAGE_ORDER: Record<string, number> = Object.fromEntries(
  STAGES.map((s, i) => [s, i]),
);
