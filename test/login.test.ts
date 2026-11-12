import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { readFileSync } from "node:fs";
import { main } from "../src/cli.ts";
import { PrtimesClient } from "../src/client.ts";
import { passwordLogin } from "../src/login.ts";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname + url.search,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : undefined,
      redirect: init.redirect,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

const LOGIN_PAGE = `<form method="POST" action="/auth/login"><input type="hidden" name="csrf_token" value="0123abcd"><input name="email"><input name="password"></form>`;

function page(body: string, cookies: string[] = [], status = 200, location?: string) {
  const headers = new Headers({ "content-type": "text/html" });
  for (const c of cookies) headers.append("set-cookie", c);
  if (location) headers.set("location", location);
  return new Response(body, { status, headers });
}

const TOKENS = ["srvssid=s2; path=/", "prtimes_auth_token=a.b.c; path=/; HttpOnly", "prtimes_refresh_token=r1; path=/auth; HttpOnly"];

let env: Record<string, string | undefined>;
beforeEach(() => {
  env = { ...process.env };
  process.env.PRTIMES_CLI_HOME = mkdtempSync(join(tmpdir(), "prtimes-login-"));
  delete process.env.PRTIMES_COOKIE;
  delete process.env.PRTIMES_EMAIL;
  delete process.env.PRTIMES_PASSWORD;
});
afterEach(() => {
  process.env = env;
});

test("passwordLogin posts the form with the page's csrf token and session cookie", async () => {
  const { impl, calls } = fakeFetch((c) => {
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1; path=/; HttpOnly"]);
    if (c.method === "POST" && c.path === "/auth/login") return page("", TOKENS, 302, "/my_c3/");
    throw new Error(`unexpected ${c.method} ${c.path}`);
  });
  const cookies = await passwordLogin({ email: "a@example.com", password: "p&ss word", fetchImpl: impl, minIntervalMs: 0 });
  assert.deepEqual(cookies, { srvssid: "s2", prtimes_auth_token: "a.b.c", prtimes_refresh_token: "r1" });
  const post = calls[1]!;
  assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(post.headers.Cookie, "srvssid=s1");
  assert.equal(post.redirect, "manual");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), { csrf_token: "0123abcd", email: "a@example.com", password: "p&ss word" });
});

test("passwordLogin follows redirects on prtimes.jp until the tokens arrive", async () => {
  const { impl } = fakeFetch((c) => {
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1"]);
    if (c.method === "POST") return page("", ["srvssid=s2"], 302, "https://prtimes.jp/auth/callback?x=1");
    if (c.path === "/auth/callback?x=1") return page("", TOKENS.slice(1), 302, "/my_c3/");
    throw new Error(`unexpected ${c.method} ${c.path}`);
  });
  const cookies = await passwordLogin({ email: "a@example.com", password: "p", fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(cookies.prtimes_auth_token, "a.b.c");
  assert.equal(cookies.srvssid, "s2");
});

test("wrong credentials give AUTH_ERROR without echoing the password", async () => {
  const { impl } = fakeFetch((c) => {
    if (c.method === "GET") return page(LOGIN_PAGE, ["srvssid=s1"]);
    return page(`${LOGIN_PAGE}<p class="error">メールアドレスまたはパスワードが正しくありません</p>`);
  });
  await assert.rejects(passwordLogin({ email: "a@example.com", password: "secret-pw", fetchImpl: impl, minIntervalMs: 0 }), (e: any) => {
    assert.equal(e.code, "AUTH_ERROR");
    assert.ok(!JSON.stringify({ m: e.message, d: e.detail }).includes("secret-pw"));
    return true;
  });
});

test("a redirect to another step (e.g. two-factor) gives LOGIN_UNSUPPORTED", async () => {
  const { impl } = fakeFetch((c) => {
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1"]);
    if (c.method === "POST") return page("", [], 302, "/auth/mfa");
    return page("<form>確認コード</form>");
  });
  await assert.rejects(passwordLogin({ email: "a@example.com", password: "p", fetchImpl: impl, minIntervalMs: 0 }), (e: any) => {
    assert.equal(e.code, "LOGIN_UNSUPPORTED");
    assert.match(e.message, /auth login/);
    return true;
  });
});

test("the client logs in with PRTIMES_EMAIL / PRTIMES_PASSWORD when there is no session", async () => {
  process.env.PRTIMES_EMAIL = "a@example.com";
  process.env.PRTIMES_PASSWORD = "p";
  const { impl, calls } = fakeFetch((c) => {
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1"]);
    if (c.method === "POST" && c.path === "/auth/login") return page("", TOKENS, 302, "/my_c3/");
    if (c.path === "/api/x") return new Response(JSON.stringify({ data: { ok: c.headers.Cookie } }), { status: 200 });
    throw new Error(`unexpected ${c.method} ${c.path}`);
  });
  const client = new PrtimesClient({ fetchImpl: impl, minIntervalMs: 0 });
  const data = await client.request("/api/x");
  assert.match(data.ok, /prtimes_auth_token=a\.b\.c/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /auth/login", "POST /auth/login", "GET /api/x"]);
});

test("the client logs in again with the env credentials when the refresh fails", async () => {
  process.env.PRTIMES_EMAIL = "a@example.com";
  process.env.PRTIMES_PASSWORD = "p";
  let n = 0;
  const { impl, calls } = fakeFetch((c) => {
    if (c.path === "/api/x") return n++ === 0 ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ data: 1 }), { status: 200 });
    if (c.path === "/auth/token/refresh") return new Response("", { status: 401 });
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1"]);
    if (c.method === "POST" && c.path === "/auth/login") return page("", TOKENS, 302, "/my_c3/");
    throw new Error(`unexpected ${c.method} ${c.path}`);
  });
  const client = new PrtimesClient({
    session: { cookies: { srvssid: "old", prtimes_auth_token: "x.y.z", prtimes_refresh_token: "stale" }, savedAt: "2026-01-01" },
    fetchImpl: impl,
    minIntervalMs: 0,
  });
  assert.equal(await client.request("/api/x"), 1);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /api/x", "POST /auth/token/refresh", "GET /auth/login", "POST /auth/login", "GET /api/x"]);
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (x: string) => out.push(String(x));
  console.error = (x: string) => err.push(String(x));
  return { out, err, restore: () => ((console.log = log), (console.error = error)) };
}

function loginSite() {
  return fakeFetch((c) => {
    if (c.method === "GET" && c.path === "/auth/login") return page(LOGIN_PAGE, ["srvssid=s1"]);
    if (c.method === "POST" && c.path === "/auth/login") return page("", TOKENS, 302, "/my_c3/");
    if (c.path === "/api/press_kit_edit.php/company_user/me") {
      return new Response(JSON.stringify({ data: { company_id: 85, company_name: "Co" } }), { status: 200 });
    }
    throw new Error(`unexpected ${c.method} ${c.path}`);
  });
}

test("auth login --email logs in with PRTIMES_PASSWORD and saves the session", async () => {
  process.env.PRTIMES_PASSWORD = "secret-pw";
  const { impl, calls } = loginSite();
  const io = capture();
  let code: number;
  try {
    code = await main(["auth", "login", "--email", "a@example.com"], { fetchImpl: impl });
  } finally {
    io.restore();
  }
  assert.equal(code, 0, io.err.join("\n"));
  const result = JSON.parse(io.out.join("\n"));
  assert.equal(result.loggedIn, true);
  assert.equal(result.companyId, 85);
  assert.equal(result.canRefresh, true);
  assert.equal(new URLSearchParams(calls[1]!.body).get("password"), "secret-pw");
  const saved = JSON.parse(readFileSync(result.sessionPath, "utf8"));
  assert.equal(saved.cookies.prtimes_auth_token, "a.b.c");
  assert.ok(!JSON.stringify(saved).includes("secret-pw"));
  assert.ok(!io.out.join("").includes("secret-pw"));
});

test("auth login --email without a password source on a non-terminal is a usage error", async () => {
  const { impl, calls } = loginSite();
  const io = capture();
  let code: number;
  try {
    code = await main(["auth", "login", "--email", "a@example.com"], { fetchImpl: impl, isTTY: false });
  } finally {
    io.restore();
  }
  assert.equal(code, 2);
  assert.match(io.err.join(""), /--password-stdin|PRTIMES_PASSWORD/);
  assert.equal(calls.length, 0);
});

test("auth login --password-stdin reads the first line of stdin", async () => {
  const { impl, calls } = loginSite();
  const io = capture();
  let code: number;
  try {
    code = await main(["auth", "login", "--email", "a@example.com", "--password-stdin"], { fetchImpl: impl, readStdin: async () => "pw from stdin\nignored\n" });
  } finally {
    io.restore();
  }
  assert.equal(code, 0, io.err.join("\n"));
  assert.equal(new URLSearchParams(calls[1]!.body).get("password"), "pw from stdin");
});

test("--password-stdin needs an email address", async () => {
  const io = capture();
  let code: number;
  try {
    code = await main(["auth", "login", "--password-stdin"], { readStdin: async () => "pw" });
  } finally {
    io.restore();
  }
  assert.equal(code, 2);
  assert.match(io.err.join(""), /--email/);
});
