import { launchBrowser, sleep } from "./browser.ts";
import { CliError } from "./client.ts";
import { AUTH_COOKIE, SESSION_COOKIE } from "./session.ts";

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
