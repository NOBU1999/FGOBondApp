// Python `json.dumps` 的等价实现（P3.5 数据管线要用）。
//
// 为什么不能直接用 JSON.stringify：
//  · Python 默认分隔符是 `", "` / `": "`（indent 时是 `","` / `": "`），空数组是 `[]`
//    —— 但**非空数组的元素之间**有空格。`trigger_traits_json` / `cn_unavailable_*` 这些
//    字符串是**直接存进 SQLite 的列值**，差一个空格就是两个不同的字节。
//  · Python float 用 repr（最短往返 + decpt<=-4 或 >16 才用指数、整数补 ".0"）；
//    JS 的 Number.toString 规则不同（0.00001 在 Python 是 1e-05，在 JS 是 0.00001）。

/** Python 的 float repr（含 -0.0 / 指数阈值 / 整数补 .0） */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const s = Math.abs(value).toExponential(); // 最短往返：d[.ddd]e±X
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return String(value);
  const digits = m[1] + (m[2] ?? "");
  const exp = parseInt(m[3], 10);
  const decpt = exp + 1;
  if (decpt <= -4 || decpt > 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const e = decpt - 1;
    const eStr = (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
    return `${sign}${mant}e${eStr}`;
  }
  if (decpt <= 0) return `${sign}0.${"0".repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${"0".repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** 显式标记"这是 float"（JS 分不出 20 和 20.0，靠它还原 Python 的写法） */
export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  /** 让 `JSON.stringify` 把它写成普通数字（不然会变成 {"value":0}） */
  toJSON(): number {
    return this.value;
  }
}
export const pf = (value: number): PyFloat => new PyFloat(value);

function escapeString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

export interface PyDumpOptions {
  /** 与 Python 的 indent 一致；给了就按 indent 换行缩进 */
  indent?: number | null;
  /** 只有 indent 为 null 时才用 ", " / ": " 分隔（indent 时是 "," / ": "） */
  separators?: [string, string];
  /** 等价 `json.dumps(..., sort_keys=True)`：所有对象的 key 按码点排序 */
  sortKeys?: boolean;
}

/**
 * `json.dumps(value, ensure_ascii=False, ...)` 的等价实现。
 * 数字默认按 int 写；float 请用 `pf(x)` 包一层。
 */
export function pyDumps(value: any, opts: PyDumpOptions = {}): string {
  const indent = opts.indent ?? null;
  const itemSep = opts.separators ? opts.separators[0] : indent === null ? ", " : ",";
  const keySep = opts.separators ? opts.separators[1] : ": ";

  const dump = (v: any, level: number): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return pyFloatRepr(v);
      return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
    }
    if (typeof v === "string") return escapeString(v);
    const pad = indent === null ? "" : "\n" + " ".repeat(indent * (level + 1));
    const padEnd = indent === null ? "" : "\n" + " ".repeat(indent * level);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      const parts = v.map((x) => dump(x, level + 1));
      return `[${pad}${parts.join(itemSep + pad)}${padEnd}]`;
    }
    const keys = opts.sortKeys
      ? Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      : Object.keys(v);
    if (keys.length === 0) return "{}";
    const parts = keys.map((k) => `${escapeString(k)}${keySep}${dump(v[k], level + 1)}`);
    return `{${pad}${parts.join(itemSep + pad)}${padEnd}}`;
  };

  return dump(value, 0);
}

