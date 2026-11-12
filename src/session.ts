import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Session {
  /** prtimes.jp cookies, name -> value (srvssid, prtimes_auth_token, prtimes_refresh_token, ...) */
  cookies: Record<string, string>;
  companyId?: number;
  companyName?: string;
  savedAt: string;
}

/** Cookies that make up a logged-in company session. */
export const SESSION_COOKIE = "srvssid";
export const AUTH_COOKIE = "prtimes_auth_token";
export const REFRESH_COOKIE = "prtimes_refresh_token";

export function configDir(): string {
  if (process.env.PRTIMES_CLI_HOME) return process.env.PRTIMES_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "prtimes-cli");
}

export function sessionPath(): string {
  return join(configDir(), "session.json");
}

/** Parse a `Cookie:` header style string ("a=1; b=2") into a map. */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Seconds since epoch at which a JWT expires, or null when it cannot be read. */
export function jwtExpiry(token: string | undefined): number | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}

/**
 * Load the session. `PRTIMES_COOKIE` (a raw Cookie header) overrides the saved file,
 * which is handy for CI or one-off runs.
 */
export async function loadSession(): Promise<Session | null> {
  if (process.env.PRTIMES_COOKIE) {
    return { cookies: parseCookieHeader(process.env.PRTIMES_COOKIE), savedAt: "env" };
  }
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8")) as Session;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function saveSession(session: Session): Promise<string> {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function clearSession(): Promise<boolean> {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
