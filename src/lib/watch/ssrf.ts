import http from "node:http";
import https from "node:https";
import { promises as dnsPromises } from "node:dns";

/**
 * SSRF guard for the watch source fetchers.
 *
 * A watch source URL is user-supplied, so every fetch must treat it as
 * hostile: private, loopback, link-local and cloud-metadata addresses are
 * blocked. To prevent DNS-rebinding TOCTOU (validate one resolution, connect
 * to a second), the fetch CONNECTS TO THE VALIDATED IP and only uses the
 * hostname for TLS SNI and the Host header. Redirects are followed manually,
 * and every redirect hop is revalidated the same way.
 */

export class SsrfBlockedError extends Error {}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
/** Keep source reads bounded: a monitored page is a digest, not a dump. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ResolvedAddress {
  address: string;
  family: number; // 4 or 6
}

export type ResolveFn = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultResolve: ResolveFn = (hostname) =>
  dnsPromises.lookup(hostname, { all: true, verbatim: true }) as Promise<ResolvedAddress[]>;

/**
 * Test hook: tests must not resolve or touch real networks. Never call in
 * production code paths.
 */
let testResolver: ResolveFn | null = null;
export function setSsrfResolverForTests(fn: ResolveFn | null): void {
  testResolver = fn;
}

/** Parses and scheme-checks a user-supplied URL without resolving it. */
export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SsrfBlockedError(`not a valid URL: "${raw.slice(0, 120)}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`only http and https URLs are allowed, got "${url.protocol}"`);
  }
  if (!url.hostname) throw new SsrfBlockedError("the URL has no hostname");
  return url;
}

function ipToBits(ip: string): { isV4: boolean; parts: number[]; hextets: string[] } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { isV4: true, parts: ip.split(".").map(Number), hextets: [] };
  let hextets = ip.toLowerCase();
  if (hextets.startsWith("::ffff:")) {
    // IPv4-mapped IPv6: judge by the mapped IPv4 address.
    hextets = hextets.replace(/^::ffff:/, "");
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hextets)) return { isV4: true, parts: hextets.split(".").map(Number), hextets: [] };
  }
  if (hextets.includes(":")) return { isV4: false, parts: [], hextets: hextets.split(":") };
  return null;
}

/** True when the address is private, loopback, link-local, metadata or otherwise not public. */
export function isNotPublicIp(ip: string): boolean {
  const parsed = ipToBits(ip);
  if (!parsed) return true; // cannot judge = block
  if (parsed.isV4) {
    const [a, b] = parsed.parts;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254 cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / carrier-internal
    if (a === 192 && b === 0 && parsed.parts[2] === 2) return true; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // fc00::/7 (ULA; cloud metadata uses fd00:ec2::...), fe80::/10 (link-local)
  // and ff00::/8 (multicast) all live in the FIRST hextet. Judging later
  // groups would false-block real global addresses like 2602:fd3f::/32.
  const h = parsed.hextets;
  const first = (h[0] ?? "").toLowerCase();
  if (first.startsWith("fc") || first.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  if (first.startsWith("ff")) return true; // ff00::/8 multicast
  if (ip.startsWith("2001:db8")) return true; // documentation range
  // Loopback (::1) and the unspecified address (::).
  if (ip === "::1" || ip === "::") return true;
  return false;
}

/**
 * Creation-time gate: rejects URLs that RESOLVE to non-public addresses,
 * while tolerating an environment where DNS is unavailable (every fetch
 * re-checks anyway, so security never hangs on this best-effort pass).
 */
export async function rejectPrivateTarget(raw: string, resolve?: ResolveFn): Promise<void> {
  assertHttpUrl(raw);
  try {
    await assertPublicTarget(raw, resolve);
  } catch (err) {
    if (err instanceof SsrfBlockedError && /non-public address/.test(err.message)) throw err;
  }
}

/**
 * Verifies the FULL URL is fetchable: scheme checked, and every resolved
 * address for the hostname is public. Throws SsrfBlockedError otherwise.
 */
export async function assertPublicTarget(
  raw: string,
  resolve: ResolveFn = testResolver ?? defaultResolve,
): Promise<{ url: URL; ip: string }> {
  const url = assertHttpUrl(raw);
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(url.hostname);
  } catch (err) {
    throw new SsrfBlockedError(`hostname resolution failed for ${url.hostname}: ${err instanceof Error ? err.message : err}`);
  }
  if (!addresses.length) throw new SsrfBlockedError(`no addresses resolved for ${url.hostname}`);
  for (const a of addresses) {
    if (isNotPublicIp(a.address)) {
      throw new SsrfBlockedError(
        `blocked non-public address ${a.address} for ${url.hostname} (private, loopback, link-local and cloud metadata targets are not fetchable)`,
      );
    }
  }
  // Pin to the first public address; remaining addresses already validated.
  return { url, ip: addresses[0].address };
}

export interface HopResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface SafeHttpGetOptions {
  resolve?: ResolveFn;
  maxRedirects?: number;
  timeoutMs?: number;
  /** Extra request headers (e.g. a GitHub token), added to the defaults on every hop. */
  headers?: Record<string, string>;
  /** Test hook: performs ONE validated hop so redirect logic needs no network. */
  hop?: (opts: { url: URL; ip: string }) => Promise<HopResponse>;
}

/** Performs one real GET against a PINNED IP, hostname only for SNI + Host. */
function defaultHop({ url, ip }: { url: URL; ip: string }, timeoutMs: number, extraHeaders: Record<string, string>): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: ip, // connect to the validated address, never re-resolve (anti-rebinding)
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Host: url.hostname,
          "User-Agent": "NIGHTSHIFT-ProtocolWatch/1.0 (+public monitoring)",
          Accept: "application/json, text/html;q=0.9, text/plain;q=0.8, application/xml;q=0.7",
          ...extraHeaders,
        },
        ...(isHttps ? { servername: url.hostname } : {}), // honest TLS SNI + certificate check
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new SsrfBlockedError(`response exceeds the ${MAX_BODY_BYTES} byte limit`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: { "content-type": typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : undefined, location: res.headers["location"] },
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new SsrfBlockedError(`timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}

export interface SafeHttpGetResult {
  status: number;
  body: string;
  contentType?: string;
}

/**
 * GET with an SSRF guard: validates and pins the first hop, then follows up
 * to maxRedirects redirects, revalidating every hop. Non-3xx statuses are
 * returned as-is (the caller decides whether that is an error).
 */
export async function safeHttpGet(raw: string, opts: SafeHttpGetOptions = {}): Promise<SafeHttpGetResult> {
  const resolve = opts.resolve ?? testResolver ?? defaultResolve;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hop = opts.hop ?? ((h) => defaultHop(h, timeoutMs, opts.headers ?? {}));

  let { url, ip } = await assertPublicTarget(raw, resolve);
  for (let redirects = 0; ; redirects++) {
    const res = await hop({ url, ip });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (redirects >= maxRedirects) throw new SsrfBlockedError(`too many redirects (limit ${maxRedirects})`);
      const next = new URL(res.headers.location, url); // relative redirects resolve on the same host
      // EVERY hop is revalidated: a redirect to an internal address is refused.
      const pinned = await assertPublicTarget(next.toString(), resolve);
      url = pinned.url;
      ip = pinned.ip;
      continue;
    }
    return { status: res.status, body: res.body, contentType: res.headers["content-type"] };
  }
}
