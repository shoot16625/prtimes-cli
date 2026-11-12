import {
  AUTH_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  cookieHeader,
  jwtExpiry,
  loadSession,
  saveSession,
  type Session,
} from "./session.ts";
import { passwordLogin } from "./login.ts";

export const ORIGIN = "https://prtimes.jp";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export class CliError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: unknown;
  constructor(code: string, message: string, opts: { status?: number; detail?: unknown } = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  /** multipart/form-data body (image uploads). */
  form?: FormData;
  /** application/x-www-form-urlencoded body. */
  urlencoded?: Record<string, string>;
  /** Do not follow redirects; the response's Location header is returned. */
  manualRedirect?: boolean;
  /** Return the body as text even when it is not JSON (HTML pages). */
  text?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  data: any;
}

/**
 * Client for the JSON APIs behind the PR TIMES company admin screen (prtimes.jp/my_c3).
 * Authentication is the browser's cookies: `srvssid` (PHP session) and `prtimes_auth_token`
 * (a JWT valid for 24h), renewed with `prtimes_refresh_token` via POST /auth/token/refresh.
 */
export class PrtimesClient {
  private session: Session | null | undefined;
  private readonly fetchImpl: typeof fetch;
  /** Minimum delay between requests, to stay polite with an unofficial API. */
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;

  constructor(opts: { session?: Session | null; fetchImpl?: typeof fetch; minIntervalMs?: number } = {}) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.PRTIMES_CLI_INTERVAL_MS ?? 500);
  }

  async getSession(): Promise<Session | null> {
    if (this.session === undefined) this.session = await loadSession();
    return this.session;
  }

  /** The `data` member of PR TIMES' `{data, status, message}` envelope. */
  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.requestRaw(path, opts);
    const d = res.data;
    return (d && typeof d === "object" && "data" in d ? d.data : d) as T;
  }

  async requestRaw(path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const session = await this.requireSession();
    const exp = jwtExpiry(session.cookies[AUTH_COOKIE]);
    if (exp !== null && exp * 1000 < Date.now() + 60_000 && session.cookies[REFRESH_COOKIE]) await this.refresh();

    let res = await this.send(path, opts);
    if (res.status === 401 && (session.cookies[REFRESH_COOKIE] || envCredentials())) {
      await this.refresh();
      res = await this.send(path, opts);
    }
    if (res.status >= 400) throw httpError(opts.method ?? "GET", path, res);
    return res;
  }

  /** Renew prtimes_auth_token with the refresh token, and save the new cookies. */
  async refresh(): Promise<void> {
    const session = await this.requireSession();
    if (!session.cookies[REFRESH_COOKIE]) {
      if (await this.loginWithEnv()) return;
      throw new CliError("AUTH_ERROR", "No refresh token saved. Run `prtimes-cli auth login` again.");
    }
    const res = await this.fetchRaw(`${ORIGIN}/auth/token/refresh`, {
      method: "POST",
      headers: { ...this.baseHeaders(session), "Content-Type": "text/plain; charset=UTF-8", Origin: ORIGIN, Referer: `${ORIGIN}/my_c3/mypage/index` },
    });
    const updated = applySetCookies(session.cookies, res.headers);
    if (res.status >= 400 || !updated[AUTH_COOKIE]) {
      if (await this.loginWithEnv()) return;
      throw new CliError("AUTH_ERROR", "The PR TIMES session has expired. Run `prtimes-cli auth login` again.", { status: res.status });
    }
    session.cookies = updated;
    if (session.savedAt !== "env") {
      session.savedAt = new Date().toISOString();
      await saveSession(session);
    }
  }

  /**
   * Log in with PRTIMES_EMAIL / PRTIMES_PASSWORD (for CI) and save the session.
   * Returns false when those variables are not set or PRTIMES_COOKIE is in use.
   */
  private async loginWithEnv(): Promise<boolean> {
    const creds = envCredentials();
    if (!creds) return false;
    const cookies = await passwordLogin({ ...creds, fetchImpl: this.fetchImpl, minIntervalMs: this.minIntervalMs });
    const prev = this.session;
    this.session = { cookies, companyId: prev?.companyId, companyName: prev?.companyName, savedAt: new Date().toISOString() };
    await saveSession(this.session);
    return true;
  }

  private async requireSession(): Promise<Session> {
    let session = await this.getSession();
    if ((!session || !session.cookies[SESSION_COOKIE] || !session.cookies[AUTH_COOKIE]) && (await this.loginWithEnv())) session = this.session!;
    if (!session || !session.cookies[SESSION_COOKIE] || !session.cookies[AUTH_COOKIE]) {
      throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `prtimes-cli auth login` (or `prtimes-cli auth import`).");
    }
    return session;
  }

  private baseHeaders(session: Session): Record<string, string> {
    return { "User-Agent": USER_AGENT, Accept: "application/json, text/html;q=0.9, */*;q=0.8", Cookie: cookieHeader(session.cookies) };
  }

  private async send(path: string, opts: RequestOptions): Promise<RawResponse> {
    const session = await this.requireSession();
    const method = opts.method ?? "GET";
    const url = new URL(path.startsWith("http") ? path : `${ORIGIN}${path}`);
    if (url.origin !== ORIGIN) throw new CliError("API_ERROR", `Refusing to send the session to ${url.origin}.`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers = this.baseHeaders(session);
    if (method !== "GET") {
      headers.Origin = ORIGIN;
      headers.Referer = `${ORIGIN}/my_c3/mypage/index`;
    }
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    } else if (opts.urlencoded) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.urlencoded).toString();
    }
    const res = await this.fetchRaw(url.toString(), { method, headers, body, redirect: opts.manualRedirect ? "manual" : "follow" });
    // Keep cookies the server rotates (e.g. a new session id) for the rest of this run. A 401 also
    // deletes the auth and refresh cookies; ignore that so the refresh token can still be used.
    if (res.status < 400) session.cookies = applySetCookies(session.cookies, res.headers);
    const text = await res.text();
    let data: unknown = text;
    if (text && !opts.text) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep as text
      }
    }
    return { status: res.status, headers: res.headers, data };
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    await this.throttle();
    if (process.env.PRTIMES_CLI_DEBUG) console.error(`[prtimes-cli] ${init.method ?? "GET"} ${url}`);
    try {
      return await this.fetchImpl(url, init);
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Request failed: ${(e as Error).message}`);
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}

/** PRTIMES_EMAIL and PRTIMES_PASSWORD, when both are set and PRTIMES_COOKIE is not. */
export function envCredentials(): { email: string; password: string } | null {
  const email = process.env.PRTIMES_EMAIL;
  const password = process.env.PRTIMES_PASSWORD;
  if (!email || !password || process.env.PRTIMES_COOKIE) return null;
  return { email, password };
}

/** Apply `Set-Cookie` headers to a cookie map (a deleted or expired cookie is removed). */
export function applySetCookies(cookies: Record<string, string>, headers: Headers): Record<string, string> {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!list.length) return cookies;
  const out = { ...cookies };
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const idx = pair!.indexOf("=");
    if (idx <= 0) continue;
    const name = pair!.slice(0, idx).trim();
    const value = pair!.slice(idx + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) || value === "deleted" || value === "";
    if (expired) delete out[name];
    else out[name] = value;
  }
  return out;
}

function httpError(method: string, path: string, res: RawResponse): CliError {
  const message = errorMessage(res.data);
  const code =
    res.status === 401
      ? "AUTH_ERROR"
      : res.status === 403
        ? "FORBIDDEN"
        : res.status === 404
          ? "NOT_FOUND"
          : res.status === 409
            ? "CONFLICT"
            : res.status === 429
              ? "RATE_LIMITED"
              : "API_ERROR";
  const hint = code === "AUTH_ERROR" ? " The session may be expired; run `prtimes-cli auth login` again." : "";
  return new CliError(code, `${method} ${path.split("?")[0]} -> HTTP ${res.status}.${message ? ` ${message}` : ""}${hint}`, {
    status: res.status,
    detail: typeof res.data === "string" ? res.data.slice(0, 500) : res.data,
  });
}

function errorMessage(data: unknown): string | null {
  const d = data as any;
  const raw = [d?.message, d?.error?.message, d?.errors?.[0]?.message, typeof d?.data === "string" ? d.data : null].find(
    (m) => typeof m === "string" && m.trim(),
  );
  if (!raw) return null;
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}
