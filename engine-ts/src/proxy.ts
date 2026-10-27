// 可选代理支持（2026-10-27，用户要求）。
//
// 背景：Node 的 fetch（undici）**不读** `HTTPS_PROXY`；只有进程启动时带 `--use-env-proxy` 才认
// （实测：运行时改 `NODE_USE_ENV_PROXY=1` 无效，`node --use-env-proxy` 才生效），而用户是双击 exe，
// 带不了这个开关。所以这里用 node:net/tls 自己走 HTTP 代理的 CONNECT 隧道。
//
// 设计取舍：
//  · **只在检测到代理时启用**；没有代理时一律走原来的 fetch，零风险（绝大多数用户走这条）。
//  · 不引第三方依赖，`node_modules` 依然不进包（发布包里 deliberately 不带 node_modules）。
//  · 只支持 HTTP(S) 代理（Clash / v2rayN 的"混合端口"都是 HTTP 口，够用）；SOCKS5-only 会明确报错。
//  · 不做代理认证（407 时报一句人话），也不跟随 3xx（Atlas 的导出接口不跳转，实测 200）。
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** 响应体：两种模式都按 AsyncIterable<Uint8Array> 暴露（代理模式是 Node 的 Readable） */
  body: AsyncIterable<Uint8Array>;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

let proxyUrl: string | null | undefined; // undefined = 还没探测过
let proxyLogged = false;

/** 当前生效的代理（探测一次就缓存；`FGO_NO_PROXY=1` 可强制关掉） */
export function currentProxy(): string | null {
  if (proxyUrl === undefined) proxyUrl = detectProxy();
  return proxyUrl;
}

/** 显式指定（主要给测试与将来可能的设置项用） */
export function setProxy(explicit: string | null | undefined): void {
  proxyUrl = explicit ? normalizeProxy(explicit) : null;
}

function normalizeProxy(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    // socks:// 与 socks5:// 等同按 SOCKS5 处理
    const proto = u.protocol === "socks:" ? "socks5:" : u.protocol;
    if (!["http:", "https:", "socks5:", "socks4:"].includes(proto)) return null;
    if (!u.port) u.port = proto.startsWith("socks") ? "1080" : "80";
    return `${proto}//${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

/** 日志里显示用的短描述 */
export function proxyLabel(p: string | null): string {
  if (!p) return "直连";
  return p.startsWith("socks") ? `SOCKS5 代理 ${p.replace(/^socks5:\/\//, "")}` : `HTTP 代理 ${p.replace(/^https?:\/\//, "")}`;
}

/** NO_PROXY=/NO_PROXY 支持：逗号分隔的主机后缀或 "*" */
function hostExcluded(host: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (!raw.trim()) return false;
  for (const item of raw.split(",")) {
    const pat = item.trim().toLowerCase();
    if (!pat) continue;
    if (pat === "*") return true;
    const h = host.toLowerCase();
    if (h === pat || h.endsWith(pat.startsWith(".") ? pat : `.${pat}`)) return true;
  }
  return false;
}

/** 代理来源：环境变量 → Windows 系统代理（注册表 Internet Settings） */
export function detectProxy(): string | null {
  if (process.env.FGO_NO_PROXY) return null;
  for (const k of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = normalizeProxy(process.env[k] ?? "");
    if (v) return v;
  }
  if (process.platform !== "win32") return null;
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = execFileSync("reg", ["query", key, "/v", "ProxyEnable"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    if (!/0x0*\d*1\b/i.test(enabled)) return null;
    const server = execFileSync("reg", ["query", key, "/v", "ProxyServer"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    const m = server.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!m) return null;
    let val = m[1].trim();
    if (val.includes("=")) {
      // `http=127.0.0.1:7897;https=127.0.0.1:7897`
      const parts: Record<string, string> = {};
      for (const seg of val.split(";")) {
        const [k, v] = seg.split("=");
        if (k && v) parts[k.trim().toLowerCase()] = v.trim();
      }
      // 系统里可能只配了 SOCKS（如 socks=127.0.0.1:7891）→ 也支持
      val = parts["https"] || parts["http"] || (parts["socks"] ? `socks5://${parts["socks"]}` : "");
    }
    return normalizeProxy(val);
  } catch {
    return null;
  }
}

function headersToObject(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof h.forEach === "function" && !Array.isArray(h)) {
    h.forEach((v: string, k: string) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}

/** 统一入口：有代理走隧道，没代理走 fetch（行为与原来完全一致） */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const proxy = currentProxy();
  const host = new URL(url).hostname;
  // 本地地址 / NO_PROXY 命中的主机一律直连
  if (!proxy || isLocalHost(host) || hostExcluded(host)) return fetchRequest(url, opts);
  if (!proxyLogged) {
    proxyLogged = true;
    console.error(`[data_fetcher] 走代理 ${proxy}（来自 ${process.env.HTTPS_PROXY ? "环境变量" : "系统设置"}）`);
  }
  try {
    return await tunnelRequest(proxy, url, opts);
  } catch (exc: any) {
    // 代理不可用（换了代理软件/端口变了/要求认证/只支持 SOCKS）时别让用户卡死：
    // 记一次日志，本次请求和后续请求都退回直连，至少还能更新数据（只是慢）。
    if (!proxyBroken) {
      proxyBroken = true;
      console.error(`[data_fetcher] 代理不可用（${exc?.message ?? exc}），本次退回直连`);
    }
    return fetchRequest(url, opts);
  }
}

let proxyBroken = false;

async function fetchRequest(url: string, opts: HttpOptions): Promise<HttpResult> {
  const timeoutMs = opts.timeoutMs ?? 120 * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, signal: ctrl.signal });
    return {
      status: resp.status,
      ok: resp.ok,
      headers: headersToObject(resp.headers),
      body: (resp.body ?? emptyBody()) as unknown as AsyncIterable<Uint8Array>,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  /* 空响应体 */
}

function connectTunnel(proxy: string, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const u = new URL(proxy);
  if (u.protocol.startsWith("socks")) return connectSocks5(u, host, port, timeoutMs);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    const fail = (msg: string) => {
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(`代理 ${u.host}:${u.port} 连接超时`), Math.min(timeoutMs, 30 * 1000));
    const onData = (chunk: Buffer) => {
      const head = chunk.toString("latin1");
      const code = head.match(/^HTTP\/1\.[01]\s+(\d{2,3})/);
      if (!code) return; // 继续等（响应可能被拆包）
      const n = Number(code[1]);
      if (n === 200) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        sock.removeListener("error", onError);
        resolve(sock);
        return;
      }
      if (n === 407) fail(`代理要求认证（407），当前不支持带账号密码的代理`);
      else fail(`代理拒绝 CONNECT（HTTP ${n}）`);
    };
    const onError = (e: Error) => {
      clearTimeout(timer);
      reject(e);
    };
    sock.on("data", onData);
    sock.once("error", onError);
    sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  });
}

async function tunnelRequest(proxy: string, url: string, opts: HttpOptions): Promise<HttpResult> {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const host = target.hostname;
  const port = Number(target.port || (isHttps ? 443 : 80));
  const timeoutMs = opts.timeoutMs ?? 120 * 1000;

  const rawSock = await connectTunnel(proxy, host, port, timeoutMs);
  rawSock.setNoDelay(true);
  // http:// 目标直接走隧道（不套 TLS）；https:// 才做 TLS 握手
  let sock: any = rawSock;
  if (isHttps) {
    const tlsSock = tls.connect({ socket: rawSock, servername: host });
    await once(tlsSock, "secureConnect");
    tlsSock.setNoDelay(true);
    sock = tlsSock;
  }

  // ⚠️ 不能把 TLS socket 交给 https.request（agent:false + createConnection）：实测被卡到 ~13KB/s，
  //    同一个 socket 手写 HTTP/1.1 是 299KB/s。所以这里自己写请求、自己解响应。
  const lines = [`${opts.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (k.toLowerCase() === "host") continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push("Connection: close", "", "");
  sock.write(lines.join("\r\n"));

  const src = new ChunkSource(sock);
  const headText = await src.readHead(timeoutMs);
  if (!headText) throw new Error("代理响应没有完整头部");
  const [statusLine, ...headerLines] = headText.split("\r\n");
  const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!m) throw new Error(`无法解析响应行：${statusLine.slice(0, 60)}`);
  const status = Number(m[1]);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  // 请求头带 Range 时状态码是 206 —— 结果照常用（downloadRangeRaw 要看 206 才认 total）
  const body = readBody(src, headers, status);
  return { status, ok: status >= 200 && status < 300, headers, body };
}

/** 按 Content-Length / chunked / 读到断开 三种方式产体 */
async function* readBody(src: ChunkSource, headers: Record<string, string>, status: number): AsyncGenerator<Uint8Array> {
  if (status === 204 || status === 304) return;
  const te = (headers["transfer-encoding"] ?? "").toLowerCase();
  const cl = parseInt(headers["content-length"] ?? "", 10);
  if (te.includes("chunked")) {
    for (;;) {
      const line = (await src.readLine()).trim();
      const size = parseInt(line.split(";")[0], 16);
      if (!Number.isFinite(size)) throw new Error(`chunked 长度解析失败：${line.slice(0, 40)}`);
      if (size === 0) {
        // 吃掉结尾的空行（以及可能存在的 trailer）
        try {
          await src.readLine();
        } catch {
          /* 无所谓 */
        }
        return;
      }
      let left = size;
      while (left > 0) {
        const chunk = await src.readUpTo(left);
        if (!chunk) return;
        left -= chunk.length;
        yield chunk;
      }
      await src.readLine(); // 每个 chunk 后面的 CRLF
    }
  }
  if (Number.isFinite(cl) && cl >= 0) {
    let left = cl;
    while (left > 0) {
      const chunk = await src.readUpTo(left);
      if (!chunk) return;
      left -= chunk.length;
      yield chunk;
    }
    return;
  }
  // 没有长度信息：读到断开（我们发了 Connection: close）
  for (;;) {
    const chunk = await src.readUpTo(1 << 20);
    if (!chunk) return;
    yield chunk;
  }
}

/** TLS socket 上的分块读取（自己维护残留缓冲，避免 Buffer.concat 的 O(n²)） */
class ChunkSource {
  private it: AsyncIterator<any>;
  private cur: Buffer | null = null;
  private off = 0;

  constructor(sock: NodeJS.ReadableStream) {
    this.it = (sock as any)[Symbol.asyncIterator]();
  }

  private get available(): number {
    return this.cur ? this.cur.length - this.off : 0;
  }

  private async pull(): Promise<boolean> {
    for (;;) {
      if (this.available > 0) return true;
      const r = await this.it.next();
      if (r.done) {
        this.cur = null;
        this.off = 0;
        return false;
      }
      this.cur = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
      this.off = 0;
      if (this.cur.length > 0) return true;
    }
  }

  /** 读取"最多 n 字节"（有多少给多少，至少 1 字节） */
  async readUpTo(n: number): Promise<Buffer | null> {
    if (!(await this.pull())) return null;
    const take = Math.min(n, this.available);
    const out = this.cur!.subarray(this.off, this.off + take);
    this.off += take;
    return out;
  }

  /** 读到 \r\n 为止（返回不含 CRLF 的一行） */
  async readLine(): Promise<string> {
    let acc = Buffer.alloc(0);
    for (;;) {
      if (!(await this.pull())) return acc.toString("utf8");
      const nl = this.cur!.indexOf(0x0a, this.off);
      if (nl === -1) {
        acc = Buffer.concat([acc, this.cur!.subarray(this.off)]);
        this.off = this.cur!.length;
        continue;
      }
      const seg = this.cur!.subarray(this.off, nl);
      this.off = nl + 1;
      acc = Buffer.concat([acc, seg]);
      return acc.toString("utf8").replace(/\r$/, "");
    }
  }

  /** 读到空行为止，返回整段头（不含最后的空行） */
  async readHead(timeoutMs: number): Promise<string | null> {
    let acc = Buffer.alloc(0);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) return null;
      if (!(await this.pull())) return acc.length ? acc.toString("utf8") : null;
      acc = Buffer.concat([acc, this.cur!.subarray(this.off)]);
      this.off = this.cur!.length;
      const idx = acc.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const head = acc.subarray(0, idx).toString("utf8");
        const rest = acc.subarray(idx + 4);
        this.cur = rest.length ? Buffer.from(rest) : null;
        this.off = 0;
        return head;
      }
      if (acc.length > 256 * 1024) throw new Error("响应头过大");
    }
  }
}

/** 把响应体收成字节（小文件用） */
export async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const c of body) {
    const buf = c instanceof Uint8Array ? c : new Uint8Array(c as any);
    chunks.push(buf);
    total += buf.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 响应体 → Node Readable（两种实现统一，便于 pipe 到 gunzip） */
export function bodyReadable(body: AsyncIterable<Uint8Array>): Readable {
  if (body instanceof Readable) return body;
  return Readable.from(body as any);
}

/** SOCKS5（无认证）隧道 —— 覆盖 Clash / v2rayN 常见的 socks 口 */
function connectSocks5(u: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: u.hostname, port: Number(u.port) });
    let phase: "greet" | "connect" | "done" = "greet";
    let buf = Buffer.alloc(0);
    const fail = (msg: string) => {
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail(`SOCKS5 代理 ${u.hostname}:${u.port} 超时`), Math.min(timeoutMs, 30 * 1000));
    sock.once("error", (e) => fail(`SOCKS5 连接失败：${e.message}`));
    sock.on("connect", () => {
      // 问候：VER=5, NMETHODS=1, METHOD=0(无认证)
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail("SOCKS5 版本不对");
        if (buf[1] !== 0x00) return fail("SOCKS5 代理要求认证（暂不支持账号密码）");
        buf = buf.subarray(2);
        phase = "connect";
        const hostBuf = Buffer.from(host, "utf8");
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        sock.write(req);
      }
      if (phase === "connect") {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(`SOCKS5 连接被拒（码 ${buf[1]}）`);
        // 地址类型：1=IPv4(4B) 3=域名(1+len) 4=IPv6(16B)
        const atyp = buf[3];
        let need = 0;
        if (atyp === 0x01) need = 4 + 4 + 2;
        else if (atyp === 0x03) need = 4 + 1 + (buf[4] ?? 0) + 2;
        else if (atyp === 0x04) need = 4 + 16 + 2;
        else return fail(`SOCKS5 回包地址类型不认识（${atyp}）`);
        if (buf.length < need) return;
        phase = "done";
        clearTimeout(timer);
        sock.removeAllListeners("data");
        resolve(sock);
      }
    });
  });
}
