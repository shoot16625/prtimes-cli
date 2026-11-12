import { launchBrowser, sleep } from "./browser.ts";
import { CliError, ORIGIN, USER_AGENT, applySetCookies } from "./client.ts";
import { AUTH_COOKIE, SESSION_COOKIE, cookieHeader } from "./session.ts";

export { findBrowser } from "./browser.ts";

export const LOGIN_URL = "https://prtimes.jp/auth/login";

/**
 * Open a fresh browser window on the PR TIMES company login page, let the user log in by hand,
 * and return the prtimes.jp cookies (including the HttpOnly auth and refresh tokens) once
 * `isLoggedIn` accepts them.
 */
export async function browserLogin(opts: {
  timeoutSec: number;
  browser?: string;
  isLoggedIn: (cookies: Record<string, string>) => Promise<boolean>;
}): Promise<Record<string, string>> {
  const { cdp, proc, close } = await launchBrowser({ browser: opts.browser, url: LOGIN_URL, prefix: "prtimes-cli-login-" });
  try {
    console.error("Log in to PR TIMES (企業ユーザー) in the opened browser window. Waiting...");
    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");
      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /prtimes\.jp\/auth\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send<{ cookies: Array<{ name: string; value: string; domain: string }> }>("Storage.getCookies");
        const map = Object.fromEntries(
          cookies.filter((c) => /(^|\.)prtimes\.jp$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]),
        );
        if (map[SESSION_COOKIE] && map[AUTH_COOKIE] && (await opts.isLoggedIn(map))) return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    await close();
  }
}

const MAX_REDIRECTS = 5;

/**
 * Log in with an email address and password by posting the company login form
 * (POST /auth/login with the page's csrf_token), and return the prtimes.jp cookies,
 * including the auth and refresh tokens. The password is only sent to prtimes.jp.
 */
export async function passwordLogin(opts: {
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
}): Promise<Record<string, string>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const interval = opts.minIntervalMs ?? Number(process.env.PRTIMES_CLI_INTERVAL_MS ?? 500);
  let cookies: Record<string, string> = {};
  let first = true;
  const go = async (url: string, init: { method?: string; body?: string; contentType?: string } = {}) => {
    if (!first && interval > 0) await sleep(interval);
    first = false;
    const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
    if (Object.keys(cookies).length) headers.Cookie = cookieHeader(cookies);
    if (init.method === "POST") {
      headers.Origin = ORIGIN;
      headers.Referer = LOGIN_URL;
      headers["Content-Type"] = init.contentType!;
    }
    if (process.env.PRTIMES_CLI_DEBUG) console.error(`[prtimes-cli] ${init.method ?? "GET"} ${url}`);
    let res: Response;
    try {
      res = await fetchImpl(url, { method: init.method ?? "GET", headers, body: init.body, redirect: "manual" });
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Request failed: ${(e as Error).message}`);
    }
    cookies = applySetCookies(cookies, res.headers);
    return res;
  };

  const form = await go(LOGIN_URL);
  const csrf = (await form.text()).match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
  if (form.status >= 400 || !csrf) {
    throw new CliError("API_ERROR", `Could not read the login form (HTTP ${form.status}). The login page may have changed; use \`prtimes-cli auth login\` without --email.`);
  }

  let res = await go(LOGIN_URL, {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ csrf_token: csrf, email: opts.email, password: opts.password }).toString(),
  });
  let path = "/auth/login";
  let backToForm = false;
  for (let hop = 0; ; hop++) {
    if (cookies[SESSION_COOKIE] && cookies[AUTH_COOKIE]) return cookies;
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) {
      // A page shown in place: the login form again means the credentials were refused.
      backToForm = /name="password"/.test(await res.text());
      break;
    }
    const next = new URL(location, ORIGIN);
    path = next.pathname;
    if (next.pathname === "/auth/login") {
      backToForm = true;
      break;
    }
    if (next.origin !== ORIGIN || hop >= MAX_REDIRECTS) break;
    res = await go(next.toString());
  }
  if (backToForm) {
    throw new CliError("AUTH_ERROR", `PR TIMES did not accept the email address and password for ${opts.email}. Check that it is the company user login address (企業・事業主ユーザー) and the password.`);
  }
  throw new CliError(
    "LOGIN_UNSUPPORTED",
    `Login stopped at ${path} (for example a two-factor step) and did not return a session. Use \`prtimes-cli auth login\` without --email to log in in a browser.`,
  );
}
