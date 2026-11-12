#!/usr/bin/env bun
// @bun

// src/cli.ts
import { readFile as readFile4 } from "fs/promises";
import { dirname as dirname2, resolve as resolve2 } from "path";
import { parseArgs } from "util";

// src/session.ts
import { chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
var SESSION_COOKIE = "srvssid";
var AUTH_COOKIE = "prtimes_auth_token";
var REFRESH_COOKIE = "prtimes_refresh_token";
function configDir() {
  if (process.env.PRTIMES_CLI_HOME)
    return process.env.PRTIMES_CLI_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "prtimes-cli");
}
function sessionPath() {
  return join(configDir(), "session.json");
}
function parseCookieHeader(header) {
  const out = {};
  for (const part of header.replace(/^cookie:\s*/i, "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0)
      continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name)
      out[name] = value;
  }
  return out;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}
function jwtExpiry(token) {
  const payload = token?.split(".")[1];
  if (!payload)
    return null;
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof json.exp === "number" ? json.exp : null;
  } catch {
    return null;
  }
}
async function loadSession() {
  if (process.env.PRTIMES_COOKIE) {
    return { cookies: parseCookieHeader(process.env.PRTIMES_COOKIE), savedAt: "env" };
  }
  try {
    return JSON.parse(await readFile(sessionPath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return null;
    throw e;
  }
}
async function saveSession(session) {
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  await writeFile(path, JSON.stringify(session, null, 2), { mode: 384 });
  await chmod(path, 384);
  return path;
}
async function clearSession() {
  try {
    await rm(sessionPath());
    return true;
  } catch (e) {
    if (e.code === "ENOENT")
      return false;
    throw e;
  }
}

// src/client.ts
var ORIGIN = "https://prtimes.jp";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

class CliError extends Error {
  code;
  status;
  detail;
  constructor(code, message, opts = {}) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

class PrtimesClient {
  session;
  fetchImpl;
  minIntervalMs;
  lastRequestAt = 0;
  constructor(opts = {}) {
    this.session = opts.session;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.PRTIMES_CLI_INTERVAL_MS ?? 500);
  }
  async getSession() {
    if (this.session === undefined)
      this.session = await loadSession();
    return this.session;
  }
  async request(path, opts = {}) {
    const res = await this.requestRaw(path, opts);
    const d = res.data;
    return d && typeof d === "object" && "data" in d ? d.data : d;
  }
  async requestRaw(path, opts = {}) {
    const session = await this.requireSession();
    const exp = jwtExpiry(session.cookies[AUTH_COOKIE]);
    if (exp !== null && exp * 1000 < Date.now() + 60000 && session.cookies[REFRESH_COOKIE])
      await this.refresh();
    let res = await this.send(path, opts);
    if (res.status === 401 && session.cookies[REFRESH_COOKIE]) {
      await this.refresh();
      res = await this.send(path, opts);
    }
    if (res.status >= 400)
      throw httpError(opts.method ?? "GET", path, res);
    return res;
  }
  async refresh() {
    const session = await this.requireSession();
    if (!session.cookies[REFRESH_COOKIE]) {
      throw new CliError("AUTH_ERROR", "No refresh token saved. Run `prtimes-cli auth login` again.");
    }
    const res = await this.fetchRaw(`${ORIGIN}/auth/token/refresh`, {
      method: "POST",
      headers: { ...this.baseHeaders(session), "Content-Type": "text/plain; charset=UTF-8", Origin: ORIGIN, Referer: `${ORIGIN}/my_c3/mypage/index` }
    });
    const updated = applySetCookies(session.cookies, res.headers);
    if (res.status >= 400 || !updated[AUTH_COOKIE]) {
      throw new CliError("AUTH_ERROR", "The PR TIMES session has expired. Run `prtimes-cli auth login` again.", { status: res.status });
    }
    session.cookies = updated;
    if (session.savedAt !== "env") {
      session.savedAt = new Date().toISOString();
      await saveSession(session);
    }
  }
  async requireSession() {
    const session = await this.getSession();
    if (!session || !session.cookies[SESSION_COOKIE] || !session.cookies[AUTH_COOKIE]) {
      throw new CliError("NOT_LOGGED_IN", "Not logged in. Run `prtimes-cli auth login` (or `prtimes-cli auth import`).");
    }
    return session;
  }
  baseHeaders(session) {
    return { "User-Agent": USER_AGENT, Accept: "application/json, text/html;q=0.9, */*;q=0.8", Cookie: cookieHeader(session.cookies) };
  }
  async send(path, opts) {
    const session = await this.requireSession();
    const method = opts.method ?? "GET";
    const url = new URL(path.startsWith("http") ? path : `${ORIGIN}${path}`);
    if (url.origin !== ORIGIN)
      throw new CliError("API_ERROR", `Refusing to send the session to ${url.origin}.`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined)
        url.searchParams.set(k, String(v));
    }
    const headers = this.baseHeaders(session);
    if (method !== "GET") {
      headers.Origin = ORIGIN;
      headers.Referer = `${ORIGIN}/my_c3/mypage/index`;
    }
    let body;
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
    if (res.status < 400)
      session.cookies = applySetCookies(session.cookies, res.headers);
    const text = await res.text();
    let data = text;
    if (text && !opts.text) {
      try {
        data = JSON.parse(text);
      } catch {}
    }
    return { status: res.status, headers: res.headers, data };
  }
  async fetchRaw(url, init) {
    await this.throttle();
    if (process.env.PRTIMES_CLI_DEBUG)
      console.error(`[prtimes-cli] ${init.method ?? "GET"} ${url}`);
    try {
      return await this.fetchImpl(url, init);
    } catch (e) {
      throw new CliError("NETWORK_ERROR", `Request failed: ${e.message}`);
    }
  }
  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0)
      await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}
function applySetCookies(cookies, headers) {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (!list.length)
    return cookies;
  const out = { ...cookies };
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx <= 0)
      continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) || value === "deleted" || value === "";
    if (expired)
      delete out[name];
    else
      out[name] = value;
  }
  return out;
}
function httpError(method, path, res) {
  const message = errorMessage(res.data);
  const code = res.status === 401 ? "AUTH_ERROR" : res.status === 403 ? "FORBIDDEN" : res.status === 404 ? "NOT_FOUND" : res.status === 409 ? "CONFLICT" : res.status === 429 ? "RATE_LIMITED" : "API_ERROR";
  const hint = code === "AUTH_ERROR" ? " The session may be expired; run `prtimes-cli auth login` again." : "";
  return new CliError(code, `${method} ${path.split("?")[0]} -> HTTP ${res.status}.${message ? ` ${message}` : ""}${hint}`, {
    status: res.status,
    detail: typeof res.data === "string" ? res.data.slice(0, 500) : res.data
  });
}
function errorMessage(data) {
  const d = data;
  const raw = [d?.message, d?.error?.message, d?.errors?.[0]?.message, typeof d?.data === "string" ? d.data : null].find((m) => typeof m === "string" && m.trim());
  if (!raw)
    return null;
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

// src/api.ts
var EDITOR = "/api/press_release_editor.php";
function editUrl(releaseId) {
  return `${ORIGIN}/my_c3/action.php?run=mypage&page=pressreleaseedit&release_id=${releaseId}`;
}
function previewUrl(companyId, releaseId) {
  return `${ORIGIN}/main/action.php?run=html&page=releasedetail&company_id=${companyId}&release_id=${releaseId}&owner=1`;
}
function publicUrl(companyId, releaseId) {
  return `${ORIGIN}/main/html/rd/p/${String(releaseId).padStart(9, "0")}.${String(companyId).padStart(6, "0")}.html`;
}
function currentUser(client) {
  return client.request("/api/press_kit_edit.php/company_user/me");
}
async function listReleases(client, opts) {
  const data = await client.request("/api/press_release_list.php/list", {
    query: {
      page: opts.page,
      limit: opts.limit,
      search_phrase: opts.search ?? "",
      published_flag: true,
      draft_flag: true,
      reserved_flag: true,
      publication_stopped_flag: true
    }
  });
  return { items: data?.press_release_list ?? [], pager: data?.pager ?? null };
}
function getRelease(client, releaseId) {
  return client.request(`${EDITOR}/press_release/${releaseId}`);
}
function editorInfo(client) {
  return client.request(`${EDITOR}/press_release/editor`);
}
async function csrfToken(client, releaseId) {
  const html = await client.request("/my_c3/action.php", {
    query: { run: "mypage", page: "pressreleaseedit", release_id: releaseId },
    text: true
  });
  const m = String(html).match(/id="csrf_token"[^>]*value="([^"]+)"/) ?? String(html).match(/value="([^"]+)"[^>]*id="csrf_token"/);
  if (!m)
    throw new CliError("API_ERROR", `Could not find the editor's CSRF token for release ${releaseId}. Is it your release?`);
  return m[1];
}
async function createRelease(client) {
  const res = await client.requestRaw(`${EDITOR}/press_release/new`, { method: "POST", urlencoded: {}, manualRedirect: true, text: true });
  const location = res.headers.get("location") ?? "";
  const id = Number(location.match(/release_id=(\d+)/)?.[1]);
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError("API_ERROR", `Creating a draft did not return a release id (HTTP ${res.status}, Location: ${location || "none"}).`);
  }
  return id;
}
async function uploadImage(client, releaseId, file) {
  const form = new FormData;
  form.append("image", new Blob([file.bytes], { type: file.mime }), file.name);
  const data = await client.request(`${EDITOR}/press_release/${releaseId}/image`, { method: "POST", form });
  if (!data?.file_name || !data?.file_name_s3)
    throw new CliError("API_ERROR", `Image upload of ${file.name} returned no file name.`, { detail: data });
  return data;
}
var SAVE_FIELDS = [
  "editor_version",
  "title",
  "subtitle",
  "head",
  "text",
  "footer",
  "image_file_name_main",
  "image_file_name_main_s3",
  "images",
  "release_file_name",
  "reference_file_name",
  "media_release_file_name",
  "media_reference_file_name",
  "locations",
  "keywords",
  "release_send_target_type",
  "company_release_media_join_master_id",
  "company_m_my_release_media_master_id",
  "release_additional_headline_flg",
  "release_additional_fax_flg",
  "release_fax_file_name",
  "mail_title_prefix_company_name_flg",
  "mail_title_replacing_flg",
  "mail_title",
  "mail_body_head_flg",
  "mail_body_head_text",
  "media_user_sendmail_flg",
  "socialmedia_user_sendmail_flg",
  "other_site_send_flg",
  "release_media_user_only_flg",
  "release_media_list_only_flg",
  "is_file_download_unavailable",
  "twitter_send_flg",
  "facebook_send_flg"
];
function buildSavePayload(current, content) {
  const merged = {
    ...current,
    editor_version: current?.editor_version || "3.0.0",
    title: content.title,
    subtitle: content.subtitle,
    text: content.text,
    images: content.images,
    image_file_name_main: content.mainImage?.file_name ?? null,
    image_file_name_main_s3: content.mainImage?.file_name_s3 ?? null
  };
  return Object.fromEntries(SAVE_FIELDS.map((k) => [k, merged[k] ?? defaultValue(k)]));
}
function defaultValue(key) {
  if (key === "images" || key === "locations" || key === "keywords")
    return [];
  if (key.endsWith("_flg") || key === "is_file_download_unavailable")
    return false;
  if (key.endsWith("_id") || key.startsWith("image_file_name_main"))
    return null;
  if (key === "release_send_target_type")
    return 1;
  return "";
}
async function saveRelease(client, opts) {
  const csrf = await csrfToken(client, opts.releaseId);
  const editor = await editorInfo(client);
  const editStartedAt = Number(editor?.edit_started_at);
  if (!Number.isInteger(editStartedAt))
    throw new CliError("API_ERROR", "The editor did not return edit_started_at.");
  await client.request(`${EDITOR}/press_release/${opts.releaseId}/auto_save`, {
    method: "PUT",
    json: {
      press_release: opts.pressRelease,
      csrf_token: csrf,
      edit_started_at: editStartedAt,
      company_id: opts.companyId,
      is_force_mode: false
    }
  });
}
async function deleteRelease(client, releaseId) {
  await client.request("/api/press_release_list.php/press_releases", { method: "DELETE", json: { press_release_ids: [releaseId] } });
}
async function dashboardStats(client) {
  const recentMonth = await client.request("/api/dashboard.php/recent_month_analytics");
  const topPageViews = await client.request("/api/dashboard.php/top_three_page_view_releases");
  const topSocial = await client.request("/api/dashboard.php/top_three_social_releases");
  return { recentMonth, topPageViews, topSocial };
}

// src/images.ts
import { readFile as readFile2, stat } from "fs/promises";
import { basename, isAbsolute, resolve } from "path";
var IMAGE_MAX_BYTES = 10 * 1024 * 1024;
function isLocalImageRef(src) {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//");
}
function resolveImagePath(src, baseDir) {
  const clean = decodeURIComponent(src.replace(/^<|>$/g, ""));
  return isAbsolute(clean) ? clean : resolve(baseDir, clean);
}
function sniffMime(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70)
    return "image/gif";
  return null;
}
async function readImage(path) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new CliError("INVALID_INPUT", `Image not found: ${path}`);
  }
  if (size > IMAGE_MAX_BYTES)
    throw new CliError("INVALID_INPUT", `Image is larger than 10 MB: ${path}`);
  const bytes = new Uint8Array(await readFile2(path));
  const mime = sniffMime(bytes);
  if (!mime)
    throw new CliError("INVALID_INPUT", `Unsupported image format (use PNG, JPEG or GIF): ${path}`);
  return { path, name: basename(path), mime, bytes };
}
function sizeFromS3Name(name) {
  const m = name.match(/-(\d+)x(\d+)\.[a-z]+$/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}

// src/browser.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile as readFile3, rm as rm2 } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
function browserCandidates() {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
      ];
    case "win32": {
      const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
      return roots.flatMap((r) => [
        join2(r, "Google/Chrome/Application/chrome.exe"),
        join2(r, "Microsoft/Edge/Application/msedge.exe")
      ]);
    }
    default:
      return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
}
function findBrowser(explicit) {
  const path = explicit || process.env.PRTIMES_CLI_BROWSER || browserCandidates().find((p) => existsSync(p));
  if (!path || !existsSync(path)) {
    throw new CliError("BROWSER_NOT_FOUND", "No Chrome/Edge/Chromium found. Pass --browser <path> (or set PRTIMES_CLI_BROWSER), or use `prtimes-cli auth import`.");
  }
  return path;
}

class Cdp {
  nextId = 1;
  pending = new Map;
  ws;
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id ? this.pending.get(msg.id) : undefined;
      if (!p)
        return;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(new Error(msg.error.message));
      else
        p.resolve(msg.result);
    });
  }
  static connect(url) {
    return new Promise((resolve2, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve2(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} }));
    });
  }
  close() {
    this.ws.close();
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForDevToolsPort(profileDir, proc, timeoutMs = 20000) {
  const file = join2(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new CliError("BROWSER_LAUNCH_FAILED", "Browser exited before it was ready.");
    try {
      const [port, path] = (await readFile3(file, "utf8")).trim().split(`
`);
      if (port && path)
        return `ws://127.0.0.1:${port}${path}`;
    } catch {}
    await sleep(200);
  }
  throw new CliError("BROWSER_LAUNCH_FAILED", "Timed out waiting for the browser's DevTools port.");
}
async function launchBrowser(opts) {
  const executable = findBrowser(opts.browser);
  const profileDir = await mkdtemp(join2(tmpdir(), opts.prefix));
  const proc = spawn(executable, [`--user-data-dir=${profileDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", opts.url], { stdio: "ignore" });
  const cleanup = async () => {
    proc.kill();
    await sleep(300);
    await rm2(profileDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const cdp = await Cdp.connect(await waitForDevToolsPort(profileDir, proc));
    return {
      cdp,
      proc,
      async close() {
        cdp.close();
        await cleanup();
      }
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// src/login.ts
var LOGIN_URL = "https://prtimes.jp/auth/login";
async function browserLogin(opts) {
  const { cdp, proc, close } = await launchBrowser({ browser: opts.browser, url: LOGIN_URL, prefix: "prtimes-cli-login-" });
  try {
    console.error("Log in to PR TIMES (\u4F01\u696D\u30E6\u30FC\u30B6\u30FC) in the opened browser window. Waiting...");
    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null)
        throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");
      const { targetInfos } = await cdp.send("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /prtimes\.jp\/auth\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send("Storage.getCookies");
        const map = Object.fromEntries(cookies.filter((c) => /(^|\.)prtimes\.jp$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]));
        if (map[SESSION_COOKIE] && map[AUTH_COOKIE] && await opts.isLoggedIn(map))
          return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    await close();
  }
}

// src/markdown.ts
import { randomUUID } from "crypto";

// node_modules/marked/lib/marked.esm.js
function j() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var y = j();
function ie(l) {
  y = l;
}
var D = { exec: () => null };
function B(l) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = l(n), e[n] = s), s;
  };
}
function h(l, e = "") {
  let t = typeof l == "string" ? l : l.source, n = { replace: (s, i) => {
    let r = typeof i == "string" ? i : i.source;
    return r = r.replace(T.caret, "$1"), t = t.replace(s, r), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var we = ((l = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l);
  } catch {
    return false;
  }
})();
var T = { codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm, listInterruptsParagraph: /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, endingSpaceTabChar: /[ \t]$/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, leadingSpaceTab: /^[ \t]+/, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\][ \t]+\S/, listReplaceTask: /^\[[ xX]\][ \t]+/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/, numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l) => new RegExp(`^( {0,3}${l})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: B((l) => new RegExp(`^ {0,${l}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: B((l) => new RegExp(`^ {0,${l}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)), fencesBeginRegex: B((l) => new RegExp(`^ {0,${l}}(?:\`\`\`|~~~)`)), headingBeginRegex: B((l) => new RegExp(`^ {0,${l}}#{1,6}(?:\\s|$)`)), pedanticHeadingBeginRegex: B((l) => new RegExp(`^ {0,${l}}#`)), htmlBeginRegex: B((l) => new RegExp(`^ {0,${l}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")), blockquoteBeginRegex: B((l) => new RegExp(`^ {0,${l}}>`)), nestedContainerMarkers: /^(?: {0,3}(?:(?:[*+-]|\d{1,9}[.)])[ \t]+|>[ \t]?))+/ };
var He = /^(?:[ \t]*(?:\n|$))+/;
var je = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var Ge = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
var W = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Ne = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var ae = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var Pe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
var ye = h(Pe).replace(/bull/g, ae).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Fe = h(Pe).replace(/bull/g, ae).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var le = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
var Qe = /^[^\n]+/;
var ue = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
var Ue = h(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", ue).replace("title", /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).getRegex();
var We = h(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, ae).getRegex();
var K = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var pe = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var Ke = h("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", pe).replace("tag", K).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var Se = (l) => h(le).replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", l).replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var Xe = Se(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
var Ve = Se(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
var Je = h(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", Ve).getRegex();
var ce = { blockquote: Je, code: je, def: Ue, fences: Ge, heading: Ne, hr: W, html: Ke, lheading: ye, list: We, newline: He, paragraph: Xe, table: D, text: Qe };
var Re = h("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}\t)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex();
var Ye = { ...ce, lheading: Fe, table: Re, paragraph: h(le).replace("hr", W).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", Re).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag", K).getRegex() };
var et = { ...ce, html: h(`^ *(?:comment(?: *\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1>(?: *\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?>(?: *\\n{2,}|\\s*$))`).replace("comment", pe).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: D, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: h(le).replace("hr", W).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ye).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var tt = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var nt = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var _e = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
var rt = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var $ = /[\p{P}\p{S}]/u;
var G = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var st = h(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, G).getRegex();
var it = /[\p{Pi}\p{Ps}"']/u;
var $e = /(?!~)[\p{P}\p{S}]/u;
var ot = /(?!~)[\s\p{P}\p{S}]/u;
var at = /(?:[^\s\p{P}\p{S}]|~)/u;
var lt = h(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", we ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var Le = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var ut = h(Le, "u").replace(/punct/g, $).getRegex();
var pt = h(Le, "u").replace(/punct/g, $e).getRegex();
var ct = /^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/;
var ht = h(ct, "u").replace(/openQuote/g, it).replace(/punct/g, $).getRegex();
var Ce = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var dt = h(Ce, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, G).replace(/punct/g, $).getRegex();
var gt = h(Ce, "gu").replace(/notPunctSpace/g, at).replace(/punctSpace/g, ot).replace(/punct/g, $e).getRegex();
var kt = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
var ft = h(kt, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, G).replace(/punct/g, $).getRegex();
var mt = h("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, G).replace(/punct/g, $).getRegex();
var xt = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
var bt = h(xt, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, G).replace(/punct/g, $).getRegex();
var Rt = h(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, $).getRegex();
var Tt = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Ot = h(Tt, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, G).replace(/punct/g, $).getRegex();
var wt = h(/\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var Pt = h(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, $).getRegex();
var yt = h(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var St = h(pe).replace("(?:-->|$)", "-->").getRegex();
var _t = h("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", St).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var Ie = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
var re = h(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", Ie).getRegex();
var $t = h(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label", re).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title", /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).getRegex();
var Lt = h(/^!?\[(label)\]\[(ref)\]/).replace("label", re).replace("ref", ue).getRegex();
var Ct = h(/^!?\[(ref)\](?:\[\])?/).replace("ref", ue).getRegex();
var Te = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
var It = h(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", Ie).getRegex();
var At = h("reflink|nolink(?!\\()", "g").replace("reflink", h(/^!?\[(label)\]\[(ref)\]/).replace("label", It).replace("ref", Te).getRegex()).replace("nolink", h(/^!?\[(ref)\](?:\[\])?/).replace("ref", Te).getRegex()).getRegex();
var Oe = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var Et = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
var zt = h(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, Et).getRegex();
var he = { _backpedal: D, anyPunctuation: wt, anyPunctuationOutsideCode: Pt, autolink: yt, blockSkip: lt, br: _e, code: nt, del: D, delLDelim: D, delRDelim: D, emStrongLDelim: ut, emStrongRDelimAst: dt, emStrongRDelimUnd: mt, escape: tt, link: $t, nolink: Ct, punctuation: st, reflink: Lt, reflinkSearch: At, tag: _t, text: rt, url: D };
var Mt = { ...he, emStrongLDelim: ht, emStrongRDelimAst: ft, emStrongRDelimUnd: bt, link: h(/^!?\[(label)\]\((.*?)\)/).replace("label", re).getRegex(), reflink: h(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", re).getRegex() };
var oe = { ...he, emStrongRDelimAst: gt, emStrongLDelim: pt, delLDelim: Rt, delRDelim: Ot, url: h(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol", zt).replace("protocol", Oe).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: h(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol", Oe).replace(/emailProtocol/g, /(?:mailto|xmpp):/).replace("wwwStart", we ? "(?<![^\\s*_~(])www\\." : "www\\.").getRegex() };
var Bt = { ...oe, br: h(_e).replace("{2,}", "*").getRegex(), text: h(oe.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var V = { normal: ce, gfm: Ye, pedantic: et };
var N = { normal: he, gfm: oe, breaks: Bt, pedantic: Mt };
var Dt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var Ae = (l) => Dt[l];
function P(l, e) {
  if (e) {
    if (T.escapeTest.test(l))
      return l.replace(T.escapeReplace, Ae);
  } else if (T.escapeTestNoEncode.test(l))
    return l.replace(T.escapeReplaceNoEncode, Ae);
  return l;
}
function Ee(l) {
  return T.numericCharacterReference.test(l) ? l.replace(T.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === undefined && n === undefined)
      return "&amp;";
    let s = t === undefined ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    return s === 0 || s > 1114111 || s >= 55296 && s <= 57343 ? "\uFFFD" : s === 38 ? "&amp;" : String.fromCodePoint(s);
  }) : l;
}
function de(l) {
  try {
    l = encodeURI(l).replace(T.percentDecode, "%");
  } catch {
    return null;
  }
  return l;
}
function ge(l, e) {
  let t = l.replace(T.findPipe, (i, r, o) => {
    let a = false, p = r;
    for (;--p >= 0 && o[p] === "\\"; )
      a = !a;
    return a ? "|" : " |";
  }), n = t.split(T.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e)
    if (n.length > e)
      n.splice(e);
    else
      for (;n.length < e; )
        n.push("");
  for (;s < n.length; s++)
    n[s] = n[s].trim().replace(T.slashPipe, "|");
  return n;
}
function L(l, e, t) {
  let n = l.length;
  if (n === 0)
    return "";
  let s = 0;
  for (;s < n; ) {
    let i = l.charAt(n - s - 1);
    if (i === e && !t)
      s++;
    else if (i !== e && t)
      s++;
    else
      break;
  }
  return l.slice(0, n - s);
}
function ke(l) {
  let e = l.split(`
`), t = e.length - 1;
  for (;t >= 0 && T.blankLine.test(e[t]); )
    t--;
  return e.length - t <= 2 ? l : e.slice(0, t + 1).join(`
`);
}
function Q(l) {
  return l.trim().replace(T.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}
function fe(l, e) {
  if (l.indexOf(e[0]) === -1 && l.indexOf(e[1]) === -1)
    return -1;
  let t = 0;
  for (let n = 0;n < l.length; n++)
    if (l[n] === "\\")
      n++;
    else if (l[n] === e[0])
      t++;
    else if (l[n] === e[1] && (t--, t < 0))
      return n;
  return t > 0 ? -2 : -1;
}
var F = new WeakMap;
function me(l) {
  let e = { "*": -1, _: -1 }, t = -1, n = l.length;
  for (let s = 0;s < n; s++) {
    let i = l[s];
    if (i !== "*" && i !== "_" && i !== "~")
      continue;
    let r = s === 0 ? `
` : l[s - 1], o = s + 1;
    for (;o < n && l[o] === i; )
      o++;
    r !== " " && r !== "\t" && r !== `
` && r !== "\r" && r !== "\f" && (i === "~" ? t = s : e[i] = s), s = o - 1;
  }
  return { maskedSrc: l, lastPossibleEmStrongCloserIndex: e, lastPossibleDelCloserIndex: t };
}
function ze(l, e) {
  let t = me(e), n = F.get(l);
  n ? n.push(t) : F.set(l, [t]);
}
function Me(l) {
  let e = F.get(l);
  e && (e.pop(), e.length === 0 && F.delete(l));
}
function Be(l, e, t) {
  let n = F.get(l)?.at(-1);
  return n && n.maskedSrc === e ? n.lastPossibleEmStrongCloserIndex[t] : me(e).lastPossibleEmStrongCloserIndex[t];
}
function De(l, e) {
  let t = F.get(l)?.at(-1);
  return t && t.maskedSrc === e ? t.lastPossibleDelCloserIndex : me(e).lastPossibleDelCloserIndex;
}
function J(l, e = 0) {
  let t = e, n = "";
  for (let s of l)
    if (s === "\t") {
      let i = 4 - t % 4;
      n += " ".repeat(i), t += i;
    } else
      n += s, t++;
  return n;
}
function qe(l, e, t, n, s) {
  let i = e.href, r = e.title || null, o = l[1].replace(s.other.outputLinkReplace, "$1"), a = l[0].charAt(0) === "!", p = n.state.inLink, c = n.state.linkEmitted, u = n.state.inRawBlock;
  n.state.inLink = true, n.state.linkEmitted = false;
  let d = n.inlineTokens(o), k = n.state.linkEmitted;
  if (n.state.linkEmitted = c, n.state.inLink = p, !a) {
    if (k) {
      n.state.inRawBlock = u;
      return;
    }
    n.state.linkEmitted = true;
  }
  return { type: a ? "image" : "link", raw: t, href: i, title: r, text: o, tokens: d };
}
function qt(l, e, t) {
  let n = l.match(t.other.indentCodeCompensation);
  if (n === null)
    return e;
  let s = n[1];
  return e.split(`
`).map((i) => {
    let r = i.match(t.other.beginningSpace);
    if (r === null)
      return i;
    let [o] = r;
    return i.slice(Math.min(o.length, s.length));
  }).join(`
`);
}
function ve(l, e, t, n) {
  if (!e.includes("<"))
    return false;
  for (let s = 0;s < e.length; s++) {
    if (e[s] === "\\") {
      s++;
      continue;
    }
    if (e[s] === "`") {
      let o = n.inline.code.exec(e.slice(s));
      if (o) {
        s += o[0].length - 1;
        continue;
      }
    }
    if (e[s] !== "<")
      continue;
    let i = l.slice(t + s), r = n.inline.tag.exec(i) || n.inline.autolink.exec(i);
    if (r) {
      if (r[0].length > e.length - s)
        return true;
      s += r[0].length - 1;
    }
  }
  return false;
}
var _ = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0)
      return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ke(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], s = qt(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = L(n, "#");
        (this.options.pedantic || !s || this.rules.other.endingSpaceTabChar.test(s)) && (n = s.trim());
      }
      return { type: "heading", raw: L(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t)
      return { type: "hr", raw: L(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = L(t[0], `
`).split(`
`), s = "", i = "", r = [];
      for (;n.length > 0; ) {
        let o = false, a = [], p;
        for (p = 0;p < n.length; p++)
          if (this.rules.other.blockquoteStart.test(n[p]))
            a.push(n[p]), o = true;
          else if (!o)
            a.push(n[p]);
          else
            break;
        n = n.slice(p);
        let c = a.join(`
`), u = c.replace(this.rules.other.blockquoteMarkerWhitespace, (g, b, f) => b + J(f, b.length)).replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s = s ? `${s}
${c}` : c, i = i ? `${i}
${u}` : u;
        let d = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(u, r, true), this.lexer.state.top = d, n.length === 0)
          break;
        let k = r.at(-1);
        if (k?.type === "code" || k?.type === "heading" || k?.type === "hr" || k?.type === "html" || k?.type === "table")
          break;
        if (k?.type === "blockquote") {
          let g = k, b = n.join(`
`), f = g.raw + `
` + b.replace(this.rules.other.blockquoteSetextReplace2, ""), m = this.blockquote(f);
          r[r.length - 1] = m;
          let S = f.substring(m.raw.length).replace(/^\n/, ""), R = S ? S.split(`
`).length : 0, A = R ? n.slice(0, -R) : n;
          if (A.length > 0 && (s = `${s}
${A.join(`
`)}`), i = i.substring(0, i.length - g.text.length) + m.text, n = n.slice(A.length), n.length > 0 && this.rules.other.blockquoteStart.test(n[0]))
            continue;
          break;
        } else if (k?.type === "list") {
          let g = k, b = g.raw + `
` + n.join(`
`), f = this.list(b);
          r[r.length - 1] = f;
          let m = f.raw.length > g.raw.length ? b.slice(g.raw.length + 1, f.raw.length).split(`
`).length : 0;
          if (m > 0) {
            let S = n.slice(0, m).join(`
`);
            s = `${s}
${S}`, i = `${i}
${S}`;
          }
          n = n.slice(m);
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: r, text: i };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      if (!this.options.pedantic && this.lexer.state.lastToken?.type === "text" && !this.rules.other.listInterruptsParagraph.test(e))
        return;
      let n = e, s = () => n.length - e.length, i = t[1].trim(), r = i.length > 1, o = { type: "list", raw: "", ordered: r, start: r ? +i.slice(0, -1) : "", loose: false, items: [] };
      i = r ? `\\d{1,9}\\${i.slice(-1)}` : `\\${i}`, this.options.pedantic && (i = r ? i : "[*+-]");
      let a = this.rules.other.listItemRegex(i), p = false;
      for (;e; ) {
        let u = false, d = "";
        if (!(t = a.exec(e)) || this.rules.block.hr.test(e))
          break;
        let k = s();
        e = e.substring(t[0].length);
        let g = t[2].split(`
`, 1)[0], b = t[1].length, f = this.options.pedantic ? J(g, b) : g.replace(this.rules.other.leadingSpaceTab, (v) => J(v, b)), m = e.split(`
`, 1)[0], S = !f.trim(), R = 0;
        if (this.options.pedantic ? (R = 2, d = f.trimStart()) : S ? R = b + 1 : (R = f.search(this.rules.other.nonSpaceChar), R = R > 4 ? 1 : R, d = f.slice(R), R += b), S && this.rules.other.blankLine.test(m) && (e = e.substring(m.length + 1), u = true), !u) {
          let v = this.rules.other.nextBulletRegex(R), U = this.rules.other.hrRegex(R), ee = this.rules.other.fencesBeginRegex(R), te = this.options.pedantic ? this.rules.other.pedanticHeadingBeginRegex(R) : this.rules.other.headingBeginRegex(R), M = this.rules.other.htmlBeginRegex(R), ne = this.rules.other.blockquoteBeginRegex(R), Z = false;
          for (;e; ) {
            let xe = e.split(`
`, 1)[0], H;
            if (m = xe, this.options.pedantic ? (m = m.replace(this.rules.other.listReplaceNesting, "  "), H = m) : H = m.replace(this.rules.other.leadingSpaceTab, (be) => J(be)), ee.test(m) || te.test(m) || M.test(m) || ne.test(m) || v.test(m) || U.test(m))
              break;
            if (H.search(this.rules.other.nonSpaceChar) >= R || !m.trim())
              d += `
` + H.slice(R), Z = false;
            else {
              if (S || f.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ee.test(f) || te.test(f) || M.test(f) || U.test(f))
                break;
              if (!this.options.pedantic && !Z) {
                let se = f.replace(this.rules.other.nestedContainerMarkers, "");
                if (this.rules.block.fences.test(se) || this.rules.block.heading.test(se) || this.rules.block.hr.test(se))
                  break;
              }
              let Ze = !this.options.pedantic && /^ {0,3}(?:=+|-+) *$/.test(m) && this.rules.block.lheading.test(`${f}
${m}`) ? `    ${H.replace(/^ {0,3}/, "")}` : m;
              d += `
` + Ze, Z = true;
            }
            S = !m.trim(), e = e.substring(xe.length + 1), f = H.slice(R);
          }
        }
        let A = n.slice(k, s());
        o.loose || (p ? o.loose = true : this.rules.other.doubleBlankLine.test(A) && (p = true)), o.items.push({ type: "list_item", raw: A, task: !!this.options.gfm && this.rules.other.listIsTask.test(d), loose: false, text: d, tokens: [] });
      }
      let c = o.items.at(-1);
      if (c)
        c.raw = c.raw.trimEnd(), c.text = c.text.trimEnd();
      else
        return;
      o.raw = n.slice(0, s()).trimEnd();
      for (let u of o.items)
        if (this.lexer.state.top = false, u.tokens = this.lexer.blockTokens(u.text, []), !o.loose) {
          let d = u.tokens.filter((g) => g.type === "space"), k = d.length > 0 && d.some((g) => this.rules.other.anyLine.test(g.raw));
          o.loose = k;
        }
      for (let u of o.items) {
        let d = u.tokens[0];
        if (u.task && (d?.type === "text" || d?.type === "paragraph")) {
          u.text = u.text.replace(this.rules.other.listReplaceTask, ""), d.raw = d.raw.replace(this.rules.other.listReplaceTask, ""), d.text = d.text.replace(this.rules.other.listReplaceTask, "");
          for (let g = this.lexer.inlineQueue.length - 1;g >= 0; g--)
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
              this.lexer.inlineQueue[g].src = this.lexer.inlineQueue[g].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          let k = this.rules.other.listTaskCheckbox.exec(u.raw);
          if (k) {
            let g = { type: "checkbox", raw: k[0] + " ", checked: k[0] !== "[ ]" };
            u.checked = g.checked, o.loose ? u.tokens[0] && ["paragraph", "text"].includes(u.tokens[0].type) && "tokens" in u.tokens[0] && u.tokens[0].tokens ? (u.tokens[0].raw = g.raw + u.tokens[0].raw, u.tokens[0].text = g.raw + u.tokens[0].text, u.tokens[0].tokens.unshift(g)) : u.tokens.unshift({ type: "paragraph", raw: g.raw, text: g.raw, tokens: [g] }) : u.tokens.unshift(g);
          }
        } else
          u.task && (u.task = false);
      }
      if (o.loose)
        for (let u of o.items) {
          u.loose = true;
          for (let d of u.tokens)
            d.type === "text" && (d.type = "paragraph");
        }
      return o;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ke(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      if (!this.rules.other.startAngleBracket.test(t[2]) && fe(t[2], "()") !== -1)
        return;
      let n = Q(t[1]), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", i = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: L(t[0], `
`), href: s, title: i };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2]))
      return;
    let n = ge(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), i = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], r = { type: "table", raw: L(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (let o of s)
        this.rules.other.tableAlignRight.test(o) ? r.align.push("right") : this.rules.other.tableAlignCenter.test(o) ? r.align.push("center") : this.rules.other.tableAlignLeft.test(o) ? r.align.push("left") : r.align.push(null);
      for (let o = 0;o < n.length; o++)
        r.header.push({ text: n[o], tokens: this.lexer.inline(n[o]), header: true, align: r.align[o] });
      for (let o of i)
        r.rows.push(ge(o, r.header.length).map((a, p) => ({ text: a, tokens: this.lexer.inline(a), header: false, align: r.align[p] })));
      return r;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: L(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t)
      return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t)
      return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t)
      return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    if (this.lexer.state.linkParenPossible === false)
      return;
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && ve(e, t[1], n, this.rules))
        return;
      let s = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(s)) {
        if (!this.rules.other.endAngleBracket.test(s))
          return;
        let a = L(s.slice(0, -1), "\\");
        if ((s.length - a.length) % 2 === 0)
          return;
      } else {
        let a = fe(t[2], "()");
        if (a === -2)
          return;
        if (a > -1) {
          let c = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + a;
          t[2] = t[2].substring(0, a), t[0] = t[0].substring(0, c).trim(), t[3] = "";
        }
      }
      let i = L(t[0].slice(0, -1), "\\");
      if ((t[0].length - i.length) % 2 === 0)
        return;
      let r = t[2], o = "";
      if (this.options.pedantic) {
        let a = this.rules.other.pedanticHrefTitle.exec(r);
        a && (r = a[1], o = a[3]);
      } else
        o = t[3] ? t[3].slice(1, -1) : "";
      return r = r.trim(), this.rules.other.startAngleBracket.test(r) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(s) ? r = r.slice(1) : r = r.slice(1, -1)), qe(t, { href: r && r.replace(this.rules.inline.anyPunctuation, "$1"), title: o && o.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let s = n[0].charAt(0) === "!" ? 2 : 1;
      if (!this.options.pedantic && ve(e, n[1], s, this.rules))
        return;
      let i = t[Q(n[2] || n[1])];
      if (!i) {
        let r = n[0].charAt(0);
        return { type: "text", raw: r, text: r };
      }
      return qe(n, i, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4])
      return;
    let i = s[0][0], r = n === i, o = t.length - e.length, a = o;
    for (;!this.options.pedantic && a > 0 && t[a - 1] === i; )
      a--;
    let p = [...t.slice(Math.max(0, a - 2), a)].at(-1) ?? "", c = p === "*" || p === "_" || !!this.rules.inline.punctuation.exec(p);
    a < o && (n = p);
    let u = a < o ? c : n === "*" || n === "_" || !!this.rules.inline.punctuation.exec(n);
    if (s[4] && n.match(this.rules.other.unicodeAlphaNumeric))
      return;
    let d = s[1] || s[3] || "";
    if (!d || !n || u) {
      let k = [...s[0]].length - 1, g, b, f = k, m = 0, S = o - a + k, R = !this.options.pedantic && !!p.trim() && (!!d || i === "*" && !c);
      if (i !== "*" && i !== "_")
        return;
      let A = i === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd, v = Be(this, t, i), U = t.length - e.length + k;
      if (v < U)
        return;
      t = t.slice(-1 * e.length + k);
      let ee = v - U;
      for (A.lastIndex = 0;(s = A.exec(t)) !== null && !(s.index > ee); ) {
        if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g)
          continue;
        if (b = [...g].length, s[3] || s[4]) {
          f += b;
          continue;
        } else if (s[5] || s[6] || R) {
          if (r && (s[5] || s[6]))
            break;
          if (S % 3 && !((S + b) % 3)) {
            m += b;
            continue;
          }
        }
        if (f -= b, f > 0)
          continue;
        b = Math.min(b, b + f + m);
        let te = [...s[0]][0].length, M = e.slice(0, k + s.index + te + b);
        if (Math.min(k, b) % 2) {
          let Z = M.slice(1, -1);
          return { type: "em", raw: M, text: Z, tokens: this.lexer.inlineTokens(Z) };
        }
        let ne = M.slice(2, -2);
        return { type: "strong", raw: M, text: ne, tokens: this.lexer.inlineTokens(ne) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), i = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return s && i && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t)
      return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s)
      return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let r = [...s[0]].length - 1, o, a, p = r, c = this.rules.inline.delRDelim, u = De(this, t), d = t.length - e.length + r;
      if (u < d)
        return;
      t = t.slice(-1 * e.length + r);
      let k = u - d;
      for (c.lastIndex = 0;(s = c.exec(t)) !== null && !(s.index > k); ) {
        if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o || (a = [...o].length, a !== r))
          continue;
        if (s[3] || s[4]) {
          p += a;
          continue;
        }
        if (p -= a, p > 0)
          continue;
        a = Math.min(a, a + p);
        let g = [...s[0]][0].length, b = e.slice(0, r + s.index + g + a), f = b.slice(r, -r);
        return { type: "del", raw: b, text: f, tokens: this.lexer.inlineTokens(f) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@")
        n = t[0], s = "mailto:" + n;
      else {
        let i;
        do
          i = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (i !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: n ? t[0] : Ee(t[0]), escaped: n };
    }
  }
};
var O = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = Object.create(null), this.options = e || y, this.options.tokenizer = this.options.tokenizer || new _, this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    let t = { other: T, block: V.normal, inline: N.normal };
    this.options.pedantic ? (t.block = V.pedantic, t.inline = N.pedantic) : this.options.gfm && (t.block = V.gfm, this.options.breaks ? t.inline = N.breaks : t.inline = N.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: V, inline: N };
  }
  static lex(e, t) {
    return new l(t).lex(e);
  }
  static lexInline(e, t) {
    return new l(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(T.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0;t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.state.inRawBlock = false, this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this;
    let s = this.state.lastToken;
    this.options.pedantic && (e = e.replace(T.tabCharGlobal, "    ").replace(T.spaceLine, ""));
    let i = 1 / 0;
    for (;e; ) {
      if (e.length < i)
        i = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      this.state.lastToken = t.at(-1);
      let r;
      if (this.options.extensions?.block?.some((a) => (r = a.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false))
        continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let a = t.at(-1);
        r.raw.length === 1 && a !== undefined ? a.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let a = t.at(-1);
        a?.type === "paragraph" || a?.type === "text" ? (a.raw += (a.raw.endsWith(`
`) ? "" : `
`) + r.raw, a.text += `
` + r.text, this.inlineQueue.at(-1).src = a.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let a = t.at(-1);
        a?.type === "paragraph" || a?.type === "text" ? (a.raw += (a.raw.endsWith(`
`) ? "" : `
`) + r.raw, a.text += `
` + r.raw, this.inlineQueue.at(-1).src = a.text) : (this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }), t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let a = 1 / 0, p = e.slice(1), c;
        this.options.extensions.startBlock.forEach((u) => {
          c = u.call({ lexer: this }, p), typeof c == "number" && c >= 0 && (a = Math.min(a, c));
        }), a < 1 / 0 && a >= 0 && (o = e.substring(0, a + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        let a = t.at(-1);
        n && a?.type === "paragraph" ? (a.raw += (a.raw.endsWith(`
`) ? "" : `
`) + r.raw, a.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = a.text) : t.push(r), n = o.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let a = t.at(-1);
        a?.type === "text" ? (a.raw += (a.raw.endsWith(`
`) ? "" : `
`) + r.raw, a.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = a.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, this.state.lastToken = s, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  linkInText(e) {
    if (!e.includes("["))
      return false;
    let t = this.tokenizer.rules.inline.link;
    for (let n of e.matchAll(this.tokenizer.rules.inline.blockSkip))
      if (t.test(n[0]) && e.charAt(n.index - 1) !== "!")
        return true;
    for (let n of e.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      let s = n[0], i = s.lastIndexOf("[");
      if (!(s.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, Q(s.slice(i + 1, -1)))) && !(i > 1 && this.linkInText(s.slice(1, i - 1))))
        return true;
    }
    return false;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = this.state.linkParenPossible;
    this.state.linkParenPossible = n && e.includes(")");
    try {
      return this.#e(e, t);
    } finally {
      this.state.linkParenPossible = n;
    }
  }
  #e(e, t) {
    let n = e.includes("*") || e.includes("_") || e.includes("~") || this.options.hooks?.emStrongMask || this.tokenizer.emStrong !== _.prototype.emStrong || this.tokenizer.del !== _.prototype.del ? this.#r(e) : e;
    ze(this.tokenizer, n);
    try {
      return this.#t(e, n, t);
    } finally {
      Me(this.tokenizer);
    }
  }
  #t(e, t, n) {
    let s = false, i = "", r = 1 / 0;
    for (;e; ) {
      if (e.length < r)
        r = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      s || (i = ""), s = false;
      let o;
      if (this.options.extensions?.inline?.some((p) => (o = p.call({ lexer: this }, e, n)) ? (e = e.substring(o.raw.length), n.push(o), true) : false))
        continue;
      if (o = this.tokenizer.escape(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.tag(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.link(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(o.raw.length);
        let p = n.at(-1);
        o.type === "text" && p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : n.push(o);
        continue;
      }
      if (o = this.tokenizer.emStrong(e, t, i)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.codespan(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.br(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.del(e, t, i)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (o = this.tokenizer.autolink(e)) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      if (!this.state.inLink && (o = this.tokenizer.url(e))) {
        e = e.substring(o.raw.length), n.push(o);
        continue;
      }
      let a = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, c = e.slice(1), u;
        this.options.extensions.startInline.forEach((d) => {
          u = d.call({ lexer: this }, c), typeof u == "number" && u >= 0 && (p = Math.min(p, u));
        }), p < 1 / 0 && p >= 0 && (a = e.substring(0, p + 1));
      }
      if (o = this.tokenizer.inlineText(a)) {
        e = e.substring(o.raw.length), o.raw.slice(-1) !== "_" && (i = o.raw.slice(-1)), s = true;
        let p = n.at(-1);
        p?.type === "text" ? (p.raw += o.raw, p.text += o.text) : n.push(o);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return n;
  }
  #n(e) {
    let { blockSkip: t, tag: n, autolink: s } = this.tokenizer.rules.inline, i = "", r = 0, o;
    for (t.lastIndex = 0;o = t.exec(e); ) {
      let a = o.index + (o[2] ? o[2].length : 0), p = o.index + o[0].length;
      if (e.charAt(a) === "<") {
        let c = e.slice(a), u = n.exec(c) || s.exec(c);
        if (!u) {
          t.lastIndex = a + 1;
          continue;
        }
        p = a + u[0].length, t.lastIndex = p;
      }
      i += e.slice(r, a) + "[" + "a".repeat(p - a - 2) + "]", r = p;
    }
    return i + e.slice(r);
  }
  #r(e) {
    let t = e;
    if (this.tokens.links && e.includes("[")) {
      let n = this.tokenizer.rules.inline.reflinkSearch, s = (i) => {
        let r = i.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, Q(i.slice(r + 1, -1))))
          return i;
        if (r > 1 && i.charAt(0) !== "!") {
          let o = i.slice(1, r - 1);
          if (this.linkInText(o))
            return "[" + o.replace(n, s) + "][" + "a".repeat(i.length - r - 2) + "]";
        }
        return "[" + "a".repeat(i.length - 2) + "]";
      };
      t = t.replace(n, s);
    }
    return t = t.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode, (n, s, i) => i ? "+".repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, "+") + s : n), t = this.#n(t), t = this.options.hooks?.emStrongMask?.call({ lexer: this }, t) ?? t, t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent)
      console.error(t);
    else
      throw new Error(t);
  }
};
var C = class {
  options;
  parser;
  constructor(e) {
    this.options = e || y;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(T.notSpaceStart)?.[0], i = e ? e.replace(T.endingNewline, "") + `
` : "";
    return s ? '<pre><code class="language-' + P(s) + '">' + (n ? i : P(i, true)) + `</code></pre>
` : "<pre><code>" + (n ? i : P(i, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let { ordered: t, start: n } = e, s = "";
    for (let o = 0;o < e.items.length; o++) {
      let a = e.items[o];
      s += this.listitem(a);
    }
    let i = t ? "ol" : "ul", r = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + i + r + `>
` + s + "</" + i + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let i = 0;i < e.header.length; i++)
      n += this.tablecell(e.header[i]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let i = 0;i < e.rows.length; i++) {
      let r = e.rows[i];
      n = "";
      for (let o = 0;o < r.length; o++)
        n += this.tablecell(r[o]);
      s += this.tablerow({ text: n });
    }
    return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${P(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, text: n, tokens: s, autolink: i }) {
    let r = i ? P(n, true) : this.parser.parseInline(s), o = de(e);
    if (o === null)
      return r;
    e = P(o, i);
    let a = '<a href="' + e + '"';
    return t && (a += ' title="' + P(t) + '"'), a += ">" + r + "</a>", a;
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let i = de(e);
    if (i === null)
      return P(n);
    e = i;
    let r = `<img src="${P(e)}" alt="${P(n)}"`;
    return t && (r += ` title="${P(t)}"`), r += ">", r;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : ("escaped" in e) && e.escaped ? e.text : P(e.text);
  }
};
var E = class {
  parser;
  strong({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  em({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  image({ text: e, tokens: t }) {
    return t ? this.parser.parseInline(t, this) : e;
  }
  br() {
    return `
`;
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var w = class l2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || y, this.options.renderer = this.options.renderer || new C, this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new E, this.textRenderer.parser = this;
  }
  static parse(e, t) {
    return new l2(t).parse(e);
  }
  static parseInline(e, t) {
    return new l2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0;n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let r = s, o = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (o !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "checkbox", "html", "def", "paragraph", "text"].includes(r.type)) {
          t += o === false ? "" : o ?? "";
          continue;
        }
      }
      let i = s;
      switch (i.type) {
        case "space": {
          t += this.renderer.space(i);
          break;
        }
        case "hr": {
          t += this.renderer.hr(i);
          break;
        }
        case "heading": {
          t += this.renderer.heading(i);
          break;
        }
        case "code": {
          t += this.renderer.code(i);
          break;
        }
        case "table": {
          t += this.renderer.table(i);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(i);
          break;
        }
        case "list": {
          t += this.renderer.list(i);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(i);
          break;
        }
        case "html": {
          t += this.renderer.html(i);
          break;
        }
        case "def": {
          t += this.renderer.def(i);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(i);
          break;
        }
        case "text": {
          t += this.renderer.text(i);
          break;
        }
        default: {
          let r = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent)
            return console.error(r), "";
          throw new Error(r);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0;s < e.length; s++) {
      let i = e[s];
      if (this.options.extensions?.renderers?.[i.type]) {
        let o = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (o !== false || !["escape", "html", "link", "image", "checkbox", "strong", "em", "codespan", "br", "del", "text"].includes(i.type)) {
          n += o === false ? "" : o ?? "";
          continue;
        }
      }
      let r = i;
      switch (r.type) {
        case "escape": {
          n += t.text(r);
          break;
        }
        case "html": {
          n += t.html(r);
          break;
        }
        case "link": {
          n += t.link(r);
          break;
        }
        case "image": {
          n += t.image(r);
          break;
        }
        case "checkbox": {
          n += t.checkbox(r);
          break;
        }
        case "strong": {
          n += t.strong(r);
          break;
        }
        case "em": {
          n += t.em(r);
          break;
        }
        case "codespan": {
          n += t.codespan(r);
          break;
        }
        case "br": {
          n += t.br(r);
          break;
        }
        case "del": {
          n += t.del(r);
          break;
        }
        case "text": {
          n += t.text(r);
          break;
        }
        default: {
          let o = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent)
            return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return n;
  }
};
var I = class {
  options;
  block;
  constructor(e) {
    this.options = e || y;
  }
  static passThroughHooks = new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? O.lex : O.lexInline;
  }
  provideParser(e = this.block) {
    return e ? w.parse : w.parseInline;
  }
};
function z(l3, e) {
  if (Array.isArray(e))
    for (let t = 0;t < e.length; t++)
      l3.push(e[t]);
  else
    l3.push(e);
}
var Y = class {
  defaults = j();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = w;
  Renderer = C;
  TextRenderer = E;
  Lexer = O;
  Tokenizer = _;
  Hooks = I;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e)
      switch (z(n, t.call(this, s)), s.type) {
        case "table": {
          let i = s;
          for (let r of i.header)
            z(n, this.walkTokens(r.tokens, t));
          for (let r of i.rows)
            for (let o of r)
              z(n, this.walkTokens(o.tokens, t));
          break;
        }
        case "list": {
          let i = s;
          z(n, this.walkTokens(i.items, t));
          break;
        }
        default: {
          let i = s;
          this.defaults.extensions?.childTokens?.[i.type] ? this.defaults.extensions.childTokens[i.type].forEach((r) => {
            let o = i[r].flat(1 / 0);
            z(n, this.walkTokens(o, t));
          }) : i.tokens && z(n, this.walkTokens(i.tokens, t));
        }
      }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: Object.create(null), childTokens: Object.create(null) };
    return e.forEach((n) => {
      let s = { ...n };
      if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((i) => {
        if (!i.name)
          throw new Error("extension name required");
        if ("renderer" in i) {
          let r = t.renderers[i.name];
          r ? t.renderers[i.name] = function(...o) {
            let a = i.renderer.apply(this, o);
            return a === false && (a = r.apply(this, o)), a;
          } : t.renderers[i.name] = i.renderer;
        }
        if ("tokenizer" in i) {
          if (!i.level || i.level !== "block" && i.level !== "inline")
            throw new Error("extension level must be 'block' or 'inline'");
          let r = t[i.level];
          r ? r.unshift(i.tokenizer) : t[i.level] = [i.tokenizer], i.start && (i.level === "block" ? t.startBlock ? t.startBlock.push(i.start) : t.startBlock = [i.start] : i.level === "inline" && (t.startInline ? t.startInline.push(i.start) : t.startInline = [i.start]));
        }
        "childTokens" in i && i.childTokens && (t.childTokens[i.name] = i.childTokens);
      }), s.extensions = t), n.renderer) {
        let i = this.defaults.renderer || new C(this.defaults);
        for (let r in n.renderer) {
          if (!(r in i))
            throw new Error(`renderer '${r}' does not exist`);
          if (["options", "parser"].includes(r))
            continue;
          let o = r, a = n.renderer[o], p = i[o];
          i[o] = (...c) => {
            let u = a.apply(i, c);
            return u === false && (u = p.apply(i, c)), u === false ? "" : u ?? "";
          };
        }
        s.renderer = i;
      }
      if (n.tokenizer) {
        let i = this.defaults.tokenizer || new _(this.defaults);
        for (let r in n.tokenizer) {
          if (!(r in i))
            throw new Error(`tokenizer '${r}' does not exist`);
          if (["options", "rules", "lexer"].includes(r))
            continue;
          let o = r, a = n.tokenizer[o], p = i[o];
          i[o] = (...c) => {
            let u = a.apply(i, c);
            return u === false && (u = p.apply(i, c)), u;
          };
        }
        s.tokenizer = i;
      }
      if (n.hooks) {
        let i = this.defaults.hooks || new I;
        for (let r in n.hooks) {
          if (!(r in i))
            throw new Error(`hook '${r}' does not exist`);
          if (["options", "block"].includes(r))
            continue;
          let o = r, a = n.hooks[o], p = i[o];
          I.passThroughHooks.has(r) ? i[o] = (c) => {
            if (i.options.async && I.passThroughHooksRespectAsync.has(r))
              return (async () => {
                let d = await a.call(i, c);
                return p.call(i, d);
              })();
            let u = a.call(i, c);
            return p.call(i, u);
          } : i[o] = (...c) => {
            if (i.options.async)
              return (async () => {
                let d = await a.apply(i, c);
                return d === false && (d = await p.apply(i, c)), d;
              })();
            let u = a.apply(i, c);
            return u === false && (u = p.apply(i, c)), u;
          };
        }
        s.hooks = i;
      }
      if (n.walkTokens) {
        let i = this.defaults.walkTokens, r = n.walkTokens;
        s.walkTokens = function(o) {
          let a = [];
          return z(a, r.call(this, o)), i && z(a, i.call(this, o)), a;
        };
      }
      this.defaults = { ...this.defaults, ...s };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return O.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return w.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let i = { ...s }, r = { ...this.defaults, ...i }, o = this.onError(!!r.silent, !!r.async);
      if (this.defaults.async === true && i.async === false)
        return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null)
        return o(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string")
        return o(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (r.hooks && (r.hooks.options = r, r.hooks.block = e), r.async)
        return (async () => {
          let a = r.hooks ? await r.hooks.preprocess(n) : n, c = await (r.hooks ? await r.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(a, r), u = r.hooks ? await r.hooks.processAllTokens(c) : c;
          r.walkTokens && await Promise.all(this.walkTokens(u, r.walkTokens));
          let k = await (r.hooks ? await r.hooks.provideParser(e) : e ? w.parse : w.parseInline)(u, r);
          return r.hooks ? await r.hooks.postprocess(k) : k;
        })().catch(o);
      try {
        r.hooks && (n = r.hooks.preprocess(n));
        let p = (r.hooks ? r.hooks.provideLexer(e) : e ? O.lex : O.lexInline)(n, r);
        r.hooks && (p = r.hooks.processAllTokens(p)), r.walkTokens && this.walkTokens(p, r.walkTokens);
        let u = (r.hooks ? r.hooks.provideParser(e) : e ? w.parse : w.parseInline)(p, r);
        return r.hooks && (u = r.hooks.postprocess(u)), u;
      } catch (a) {
        return o(a);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let s = "<p>An error occurred:</p><pre>" + P(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t)
        return Promise.reject(n);
      throw n;
    };
  }
};
var q = new Y;
function x(l3, e) {
  return q.parse(l3, e);
}
x.options = x.setOptions = function(l3) {
  return q.setOptions(l3), x.defaults = q.defaults, ie(x.defaults), x;
};
x.getDefaults = j;
x.defaults = y;
function vt(...l3) {
  return q.use(...l3), x.defaults = q.defaults, ie(x.defaults), x;
}
x.use = vt;
x.walkTokens = function(l3, e) {
  return q.walkTokens(l3, e);
};
x.parseInline = q.parseInline;
x.Parser = w;
x.parser = w.parse;
x.Renderer = C;
x.TextRenderer = E;
x.Lexer = O;
x.lexer = O.lex;
x.Tokenizer = _;
x.Hooks = I;
x.parse = x;
var Ln = x.options;
var Cn = x.setOptions;
var In = x.walkTokens;
var An = x.parseInline;
var zn = w.parse;
var Mn = O.lex;

// src/markdown.ts
var TITLE_MAX = 100;
var SUBTITLE_MAX = 100;
var BODY_MAX = 8000;
var IMAGES_MAX = 30;
function parseRelease(source) {
  let markdown = source.replace(/^\uFEFF/, "").replace(/\r\n/g, `
`);
  const frontmatter = {};
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split(`
`)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m)
        frontmatter[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
    markdown = markdown.slice(fm[0].length);
  }
  let title = frontmatter.title || undefined;
  if (!title) {
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*#*\s*(\n|$)/);
    if (h1) {
      title = h1[1].trim();
      markdown = markdown.slice(h1[0].length);
    }
  }
  return { title, subtitle: frontmatter.subtitle || undefined, markdown: markdown.replace(/^\n+/, ""), frontmatter };
}
function imageRefs(markdown) {
  const refs = [];
  const marked = new Y({ gfm: true });
  marked.walkTokens(marked.lexer(markdown), (t) => {
    if (t.type === "image")
      refs.push(t.href);
  });
  return [...new Set(refs)];
}
function markdownToPrtimesHtml(markdown, opts = {}) {
  const warnings = [];
  const images = opts.images ?? new Map;
  const used = [];
  const marked = new Y({ gfm: true, breaks: true });
  const isUploaded = (t) => t.type === "image" && images.has(t.href);
  const imageBlock = (t) => {
    const img = images.get(t.href);
    const caption = t.title ?? "";
    used.push({ file_name: img.file_name, file_name_s3: img.file_name_s3, caption });
    const size = img.width && img.height ? ` data-original-width="${img.width}" data-original-height="${img.height}"` : "";
    const src = `/api/file.php?t=origin&amp;f=${encodeURIComponent(img.file_name)}&amp;s3=${encodeURIComponent(img.file_name_s3)}`;
    return `<div class="pr-img"><figure class="pr-img__item--large"><img src="${src}" data-filename="${esc(img.file_name)}" data-filenames3="${esc(img.file_name_s3)}"${size}>` + `<figcaption class="pr-img__item__caption">${esc(caption)}</figcaption></figure></div>`;
  };
  marked.use({
    renderer: {
      heading(token) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth <= 2)
          return `<h2>${inner}</h2>`;
        if (token.depth === 3)
          return `<h3>${inner}</h3>`;
        return `<p><strong>${inner}</strong></p>
`;
      },
      paragraph(token) {
        const lone = loneUrl(token);
        const yt2 = lone ? youtubeId(lone) : null;
        if (lone && yt2) {
          return `<div class="pr-embed--youtube" data-url="https://www.youtube.com/watch?v=${yt2}"><img src="/api/movieim.php?url=www.youtube.com/watch?v=${yt2}"></div><p></p>
`;
        }
        const annotation = /^[\u203B\uFF0A*]/.test(token.text.trim()) && !token.text.trim().startsWith("**");
        const open = annotation ? `<p class="pr-annotation">` : "<p>";
        if (!token.tokens.some(isUploaded))
          return `${open}${this.parser.parseInline(token.tokens)}</p>
`;
        let out = "";
        let run = [];
        const flush = () => {
          const inner = this.parser.parseInline(run).replace(/^(\s|<br>)+|(\s|<br>)+$/g, "");
          if (inner)
            out += `${open}${inner}</p>
`;
          run = [];
        };
        for (const t of token.tokens) {
          if (isUploaded(t)) {
            flush();
            out += imageBlock(t);
          } else
            run.push(t);
        }
        flush();
        return out;
      },
      image(token) {
        warnings.push(`Image not uploaded (only local files on their own line are): ${token.href}`);
        return `<a target="_blank" rel="nofollow ugc noopener" class="pr-link" href="${esc(token.href)}">${esc(token.text || token.href)}</a>`;
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        return `<a target="_blank" rel="nofollow ugc noopener" class="pr-link" data-link-id="${randomUUID()}" href="${esc(token.href)}">${text}</a>`;
      },
      strong(token) {
        return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;
      },
      em(token) {
        return `<em>${this.parser.parseInline(token.tokens)}</em>`;
      },
      del(token) {
        return this.parser.parseInline(token.tokens);
      },
      codespan(token) {
        return token.text;
      },
      br() {
        return "<br>";
      },
      list(token) {
        const tag = token.ordered ? "ol" : "ul";
        const items = token.items.map((item) => {
          const inner = item.tokens.map((t) => t.type === "text" ? `<p>${this.parser.parseInline(t.tokens ?? [t])}</p>
` : this.parser.parse([t])).join("");
          return `<li>${inner}</li>
`;
        }).join("");
        return `<${tag}>${items}</${tag}>
`;
      },
      blockquote(token) {
        return `<div class="pr-box">${this.parser.parse(token.tokens)}</div>
`;
      },
      hr() {
        return `<hr>
`;
      },
      code(token) {
        warnings.push("Code blocks have no PR TIMES equivalent; converted to plain paragraphs.");
        return `<p>${esc(token.text).replace(/\n/g, "<br>")}</p>
`;
      },
      table(token) {
        warnings.push("Tables are not converted to the editor's table block; rows became paragraphs. Recreate the table in the editor if needed.");
        const row = (cells) => `<p>${cells.map((c) => this.parser.parseInline(c.tokens)).join(" / ")}</p>
`;
        return row(token.header) + token.rows.map(row).join("");
      },
      html(token) {
        if (/^\s*<!--[\s\S]*-->\s*$/.test(token.text))
          return "";
        warnings.push("Raw HTML is not passed through; it was escaped.");
        return esc(token.text);
      },
      text(token) {
        if ("tokens" in token && token.tokens)
          return this.parser.parseInline(token.tokens);
        return esc(token.text);
      }
    }
  });
  const html = marked.parse(markdown, { async: false }).trim();
  const textLength = visibleTextLength(html);
  if (textLength > BODY_MAX)
    warnings.push(`Body is ${textLength} characters; PR TIMES allows ${BODY_MAX}.`);
  if (used.length > IMAGES_MAX)
    warnings.push(`The body has ${used.length} images; PR TIMES allows ${IMAGES_MAX}.`);
  return { html, textLength, images: used, warnings };
}
function loneUrl(token) {
  const parts = token.tokens.filter((t2) => !(t2.type === "text" && !t2.raw.trim()));
  if (parts.length !== 1)
    return null;
  const t = parts[0];
  if (t.type === "link" && (t.text === t.href || t.raw === t.href))
    return t.href;
  return null;
}
function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    if (host === "youtu.be")
      return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com") {
      if (u.pathname === "/watch")
        return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/);
      if (m)
        return m[2];
    }
  } catch {}
  return null;
}
function htmlToText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, `
`).replace(/<div class="pr-img">[\s\S]*?<figcaption[^>]*>([\s\S]*?)<\/figcaption>[\s\S]*?<\/div>/g, (_m, cap) => `[\u753B\u50CF${cap ? `: ${cap}` : ""}]
`).replace(/<div class="pr-embed--youtube" data-url="([^"]+)"[\s\S]*?<\/div>/g, `$1
`).replace(/<h2[^>]*>/g, `
## `).replace(/<h3[^>]*>/g, `
### `).replace(/<li[^>]*>/g, "- ").replace(/<\/(p|h2|h3|li|div)>/g, `
`).replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, `

`).trim();
}
function visibleTextLength(html) {
  return [...decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s/g, "")].length;
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// src/cli.ts
var DEFAULT_MAX_CHARS = "20000";
var CONTENT_OPTIONS = {
  title: { type: "string" },
  subtitle: { type: "string" },
  "main-image": { type: "string" },
  "dry-run": { type: "boolean" }
};
var COMMANDS = {
  "auth login": {
    usage: "auth login [--timeout <sec>] [--browser <path to Chrome/Edge/Chromium>]",
    summary: "Open a browser, log in to PR TIMES by hand, and save the session cookies",
    options: { timeout: { type: "string", default: "300" }, browser: { type: "string" } },
    async run({ values }) {
      const cookies = await browserLogin({
        timeoutSec: int(values.timeout, "timeout"),
        browser: typeof values.browser === "string" ? values.browser : undefined,
        isLoggedIn: async (c) => {
          try {
            await currentUser(new PrtimesClient({ session: { cookies: c, savedAt: "probe" } }));
            return true;
          } catch {
            return false;
          }
        }
      });
      return finishLogin(cookies);
    }
  },
  "auth import": {
    usage: "auth import [--cookie '<Cookie request header>']   (or pipe it via stdin)",
    summary: "Save a session from the Cookie request header of a logged-in prtimes.jp request (copied from browser DevTools)",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      return finishLogin(parseImportedCookies(raw));
    }
  },
  "auth status": {
    usage: "auth status",
    summary: "Show whether the saved session is valid and which company it belongs to",
    async run({ client }) {
      const session = await loadSession();
      if (!session)
        return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const me2 = await currentUser(client);
        return {
          loggedIn: true,
          companyId: me2.company_id,
          companyName: me2.company_name,
          user: `${me2.first_name} ${me2.last_name}`.trim(),
          plan: me2.plan_name,
          canRefresh: Boolean(session.cookies[REFRESH_COOKIE]),
          savedAt: session.savedAt
        };
      } catch (e) {
        if (e instanceof CliError && (e.code === "AUTH_ERROR" || e.code === "NOT_LOGGED_IN")) {
          return { loggedIn: false, reason: e.message, sessionPath: sessionPath() };
        }
        throw e;
      }
    }
  },
  "auth logout": {
    usage: "auth logout",
    summary: "Delete the saved session file",
    async run() {
      return { removed: await clearSession(), sessionPath: sessionPath() };
    }
  },
  "release list": {
    usage: "release list [--page <n>] [--limit <n>] [--search <phrase>] [--status draft|reserved|released|withdrawn_by_review]",
    summary: "List your company's press releases (drafts, scheduled, delivered), newest first",
    options: {
      page: { type: "string", default: "1" },
      limit: { type: "string", default: "20" },
      search: { type: "string" },
      status: { type: "string" }
    },
    async run({ values, client }) {
      const res = await listReleases(client, {
        page: int(values.page, "page"),
        limit: int(values.limit, "limit"),
        search: typeof values.search === "string" ? values.search : undefined
      });
      const items = res.items.map((r) => ({
        releaseId: r.release_id,
        title: r.title,
        status: r.delivery_status,
        date: r.display_date,
        feeStatus: r.fee_status,
        mainImageUrl: r.main_image_url,
        url: r.delivery_status === "released" ? publicUrl(r.company_id, r.release_id) : null,
        editUrl: editUrl(r.release_id)
      })).filter((r) => values.status ? r.status === values.status : true);
      return { pager: res.pager, count: items.length, releases: items };
    }
  },
  "release get": {
    usage: "release get <release_id|url> [--html] [--max-chars <n>]",
    summary: "Read a release (title, body, images, categories, status) as the editor holds it",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]);
      const r = await getRelease(client, id);
      if (!r || typeof r !== "object")
        throw new CliError("NOT_FOUND", `Release ${id} not found.`);
      return {
        releaseId: r.release_id,
        companyId: r.company_id,
        status: r.delivery_status,
        title: r.title,
        subtitle: r.subtitle,
        releaseDate: r.release_date,
        releaseTypeId: r.release_type_id || null,
        businessCategoryIds: [r.busi_cate_id_main, r.busi_cate_id_sub].filter((x2) => x2 != null),
        keywords: r.keywords ?? [],
        mainImage: r.image_file_name_main_s3 ?? null,
        images: (r.images ?? []).length,
        editUrl: editUrl(r.release_id),
        previewUrl: previewUrl(r.company_id, r.release_id),
        url: r.delivery_status === "released" ? publicUrl(r.company_id, r.release_id) : null,
        ...bodyField(String(r.text ?? ""), Boolean(values.html), int(values["max-chars"], "max-chars"))
      };
    }
  },
  "draft create": {
    usage: "draft create <file.md|-> [--title <t>] [--subtitle <s>] [--main-image <file>] [--dry-run]",
    summary: "Create a new draft from Markdown; local images are uploaded, the first one becomes the main image unless --main-image is given",
    options: CONTENT_OPTIONS,
    args: 1,
    async run({ values, positionals, client }) {
      const input = await readInput(positionals[0], values);
      if (values["dry-run"])
        return dryRun(input);
      const id = await createRelease(client);
      try {
        const saved = await uploadAndSave(client, id, input);
        return { created: true, ...saved };
      } catch (e) {
        if (e instanceof CliError) {
          throw new CliError(e.code, `${e.message} (An empty draft ${id} was created; fix the problem and run \`draft update ${id}\`.)`, {
            status: e.status,
            detail: e.detail
          });
        }
        throw e;
      }
    }
  },
  "draft update": {
    usage: "draft update <release_id|url> <file.md|-> [--title <t>] [--subtitle <s>] [--main-image <file>] [--dry-run]",
    summary: "Overwrite a draft's title, subtitle, body and images with Markdown (drafts only)",
    options: CONTENT_OPTIONS,
    args: 2,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]);
      const input = await readInput(positionals[1], values);
      if (values["dry-run"])
        return dryRun(input);
      return { updated: true, ...await uploadAndSave(client, id, input) };
    }
  },
  "draft delete": {
    usage: "draft delete <release_id|url> --yes",
    summary: "Delete a draft (drafts only)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]);
      if (!values.yes)
        throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const current = await getRelease(client, id);
      assertDraft(current, id);
      await deleteRelease(client, id);
      return { deleted: true, releaseId: id, title: current.title };
    }
  },
  stats: {
    usage: "stats",
    summary: "Dashboard numbers for the last month: page views, visitors, reprints, followers, top releases",
    async run({ client }) {
      const s = await dashboardStats(client);
      return { recentMonth: s.recentMonth, topPageViews: s.topPageViews, topSocial: s.topSocial };
    }
  }
};
async function readInput(file, values) {
  const source = file === "-" ? await readStdin() : await readFile4(file, "utf8").catch(() => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}.`);
  });
  const baseDir = file === "-" ? process.cwd() : dirname2(resolve2(file));
  const parsed = parseRelease(source);
  const title = (typeof values.title === "string" ? values.title : parsed.title)?.trim();
  const subtitle = (typeof values.subtitle === "string" ? values.subtitle : parsed.subtitle ?? "").trim();
  if (!title)
    throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a first `# Heading`, or --title.");
  if ([...title].length > TITLE_MAX)
    throw new CliError("INVALID_INPUT", `Title is ${[...title].length} characters; PR TIMES allows ${TITLE_MAX}.`);
  if ([...subtitle].length > SUBTITLE_MAX)
    throw new CliError("INVALID_INPUT", `Subtitle is ${[...subtitle].length} characters; PR TIMES allows ${SUBTITLE_MAX}.`);
  const warnings = [];
  const images = new Map;
  for (const src of imageRefs(parsed.markdown)) {
    if (!isLocalImageRef(src))
      continue;
    images.set(src, await readImage(resolveImagePath(src, baseDir)));
  }
  const mainRef = typeof values["main-image"] === "string" ? resolve2(values["main-image"]) : parsed.frontmatter.mainImage ?? parsed.frontmatter.main_image ? resolveImagePath(parsed.frontmatter.mainImage ?? parsed.frontmatter.main_image, baseDir) : null;
  const mainImage = mainRef ? await readImage(mainRef) : null;
  if (!mainImage && images.size === 0)
    warnings.push("No main image (\u30E1\u30A4\u30F3\u753B\u50CF). PR TIMES needs one before delivery; pass --main-image or add an image.");
  return { title, subtitle, markdown: parsed.markdown, baseDir, images, mainImage, warnings };
}
function dryRun(input) {
  const placeholder = new Map([...input.images.keys()].map((src) => [src, { file_name: `(upload) ${src}`, file_name_s3: `(upload) ${src}` }]));
  const converted = markdownToPrtimesHtml(input.markdown, { images: placeholder });
  return {
    dryRun: true,
    title: input.title,
    subtitle: input.subtitle,
    textLength: converted.textLength,
    images: [...input.images.values()].map((i) => i.path),
    mainImage: input.mainImage?.path ?? [...input.images.values()][0]?.path ?? null,
    html: converted.html,
    warnings: [...input.warnings, ...converted.warnings]
  };
}
async function uploadAndSave(client, id, input) {
  const current = await getRelease(client, id);
  assertDraft(current, id);
  const byPath = new Map;
  const upload = async (img) => {
    const done = byPath.get(img.path);
    if (done)
      return done;
    const up = await uploadImage(client, id, img);
    byPath.set(img.path, up);
    return up;
  };
  const bodyImages = new Map;
  for (const [src, img] of input.images) {
    const up = await upload(img);
    bodyImages.set(src, { ...up, ...sizeFromS3Name(up.file_name_s3) });
  }
  const converted = markdownToPrtimesHtml(input.markdown, { images: bodyImages });
  const main = input.mainImage ? await upload(input.mainImage) : converted.images[0] ?? null;
  const payload = buildSavePayload(current, {
    title: input.title,
    subtitle: input.subtitle,
    text: converted.html,
    images: converted.images,
    mainImage: main ? { file_name: main.file_name, file_name_s3: main.file_name_s3 } : null
  });
  await saveRelease(client, { releaseId: id, companyId: current.company_id, pressRelease: payload });
  return {
    releaseId: id,
    title: input.title,
    subtitle: input.subtitle,
    textLength: converted.textLength,
    images: converted.images.length,
    mainImage: main?.file_name_s3 ?? null,
    editUrl: editUrl(id),
    previewUrl: previewUrl(current.company_id, id),
    warnings: [...input.warnings, ...converted.warnings]
  };
}
function assertDraft(release, id) {
  if (!release || typeof release !== "object")
    throw new CliError("NOT_FOUND", `Release ${id} not found.`);
  if (release.delivery_status !== "draft") {
    throw new CliError("NOT_DRAFT", `Release ${id} is "${release.delivery_status}", not a draft. prtimes-cli only edits drafts; change it in the admin screen.`);
  }
}
function releaseId(ref) {
  const s = ref.trim();
  const m = s.match(/^\d+$/) ? [s, s] : s.match(/[?&]release_id=(\d+)/) ?? s.match(/\/rd\/p\/0*(\d+)\.\d+\.html/);
  const id = Number(m?.[1]);
  if (!Number.isInteger(id) || id <= 0)
    throw new CliError("USAGE", `Not a release id or PR TIMES release URL: ${ref}`);
  return id;
}
async function finishLogin(cookies) {
  const client = new PrtimesClient({ session: { cookies, savedAt: "probe" } });
  const me2 = await currentUser(client);
  const path = await saveSession({ cookies, companyId: me2.company_id, companyName: me2.company_name, savedAt: new Date().toISOString() });
  return {
    loggedIn: true,
    companyId: me2.company_id,
    companyName: me2.company_name,
    canRefresh: Boolean(cookies[REFRESH_COOKIE]),
    sessionPath: path
  };
}
function parseImportedCookies(raw) {
  const cookies = parseCookieHeader(raw.trim());
  if (!cookies[SESSION_COOKIE] || !cookies[AUTH_COOKIE]) {
    throw new CliError("INVALID_INPUT", `Expected a Cookie header containing ${SESSION_COOKIE} and ${AUTH_COOKIE}.`);
  }
  return cookies;
}
function bodyField(html, asHtml, maxChars) {
  const full = asHtml ? html : htmlToText(html);
  const chars = [...full];
  const truncated = maxChars > 0 && chars.length > maxChars;
  const body = truncated ? chars.slice(0, maxChars).join("") : full;
  return { ...asHtml ? { bodyHtml: body } : { bodyText: body }, bodyChars: chars.length, truncated };
}
function int(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new CliError("USAGE", `--${name} must be a non-negative integer.`);
  return n;
}
async function readStdin() {
  if (process.stdin.isTTY)
    throw new CliError("USAGE", "Expected input on stdin.");
  const chunks = [];
  for await (const c of process.stdin)
    chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function helpText() {
  return [
    "prtimes-cli \u2014 unofficial PR TIMES CLI (JSON output)",
    "",
    "Usage: prtimes-cli <command> [options]",
    "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage}
      ${c.summary}`),
    "",
    "Env: PRTIMES_COOKIE (Cookie header, overrides saved session), PRTIMES_CLI_HOME, PRTIMES_CLI_INTERVAL_MS, PRTIMES_CLI_DEBUG, PRTIMES_CLI_BROWSER"
  ].join(`
`);
}
function findCommand(argv) {
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two])
    return { cmd: COMMANDS[two], rest: argv.slice(2) };
  if (argv[0] && COMMANDS[argv[0]])
    return { cmd: COMMANDS[argv[0]], rest: argv.slice(1) };
  return null;
}
async function main(argv, deps = {}) {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(helpText());
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group = Object.values(COMMANDS).filter((c) => c.usage.startsWith(`${argv[0]} `));
    console.error(group.length ? group.map((c) => `prtimes-cli ${c.usage}`).join(`
`) : `Unknown command: ${argv[0]}

${helpText()}`);
    return 2;
  }
  const { cmd, rest } = found;
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`prtimes-cli ${cmd.usage}
  ${cmd.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
    if (positionals.length < (cmd.args ?? 0))
      throw new CliError("USAGE", `Usage: prtimes-cli ${cmd.usage}`);
    const client = deps.client ?? new PrtimesClient;
    const result = await cmd.run({ values, positionals, client });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if (e.code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(`${e.message}
Usage: prtimes-cli ${cmd.usage}`);
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: e.stack ?? String(e) } }, null, 2));
    return 1;
  }
}

// src/bin.ts
process.exitCode = await main(process.argv.slice(2));
