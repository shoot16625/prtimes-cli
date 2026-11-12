import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { main, parseImportedCookies, releaseId } from "../src/cli.ts";
import { PrtimesClient, applySetCookies } from "../src/client.ts";
import type { Session } from "../src/session.ts";
import { RAW_EDITOR, RAW_PURPOSES } from "./fixtures.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function jwt(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "EdDSA" })}.${b64({ sub: "company::1", exp: expSec })}.sig`;
}

function session(extra: Record<string, string> = {}): Session {
  return { cookies: { srvssid: "sess", prtimes_auth_token: jwt(Date.now() / 1000 + 3600), ...extra }, savedAt: "env" };
}

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Route = (call: Call) => Response | undefined;

function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: any = init.body;
    if (typeof body === "string" && headers["Content-Type"] === "application/json") body = JSON.parse(body);
    const call = { method: init.method ?? "GET", path: url.pathname + url.search, headers, body };
    calls.push(call);
    for (const r of routes) {
      const res = r(call);
      if (res) return res;
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ data, status, message: "OK" }), { status, headers: { "content-type": "application/json", ...headers } });

const DRAFT = {
  company_id: 12345,
  release_id: 206,
  delivery_status: "draft",
  editor_version: "3.0.0",
  title: "",
  text: "",
  images: [],
  keywords: ["kept"],
  mail_body_head_text: "報道関係者各位",
  twitter_send_flg: true,
};

function editorRoutes(release: any = DRAFT): Route[] {
  return [
    (c) => (c.method === "POST" && c.path === "/api/press_release_editor.php/press_release/new"
      ? new Response("", { status: 303, headers: { location: "/my_c3/action.php?run=mypage&page=pressreleaseedit&release_id=206" } })
      : undefined),
    (c) => (c.method === "GET" && c.path === "/api/press_release_editor.php/press_release/206" ? json(release) : undefined),
    (c) => (c.method === "POST" && c.path === "/api/press_release_editor.php/press_release/206/image"
      ? json({ file_name: "d12345-206-aaa-0.png", file_name_s3: "12345-206-bbb-1200x630.png", isCMYK: false })
      : undefined),
    (c) => (c.path.startsWith("/my_c3/action.php?run=mypage&page=pressreleaseedit")
      ? new Response('<input id="csrf_token" type="hidden" name="csrf_token" value="deadbeef">', { headers: { "content-type": "text/html" } })
      : undefined),
    (c) => (c.path === "/api/press_release_editor.php/press_release/editor" ? json({ ...RAW_EDITOR, edit_started_at: 1794458650 }) : undefined),
    (c) => (c.path === "/api/press_release_editor.php/purposes" ? json(RAW_PURPOSES) : undefined),
    (c) => (c.method === "PUT" && c.path === "/api/press_release_editor.php/press_release/206/auto_save"
      ? json({ release_id: 206, edit_started_at: 1794458651 })
      : undefined),
  ];
}

let out: string[] = [];
let err: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  out = [];
  err = [];
  console.log = (s: string) => out.push(s);
  console.error = (s: string) => err.push(s);
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

function tempRelease(md: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prtimes-cli-test-"));
  writeFileSync(join(dir, "a.png"), PNG);
  const file = join(dir, "release.md");
  writeFileSync(file, md);
  return file;
}

test("draft create: creates a draft, uploads images, and saves through auto_save with the CSRF token", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("---\ntitle: 新サービス\nsubtitle: 副題\n---\n\n本文です。\n\n![](a.png \"図1\")\n");

  assert.equal(await main(["draft", "create", file], { client }), 0, err.join("\n"));
  const result = JSON.parse(out[0]!);
  assert.equal(result.created, true);
  assert.equal(result.releaseId, 206);
  assert.equal(result.mainImage, "12345-206-bbb-1200x630.png");

  const save = calls.find((c) => c.method === "PUT")!;
  assert.equal(save.body.csrf_token, "deadbeef");
  assert.equal(save.body.edit_started_at, 1794458650);
  assert.equal(save.body.company_id, 12345);
  const pr = save.body.press_release;
  assert.equal(pr.title, "新サービス");
  assert.equal(pr.subtitle, "副題");
  assert.match(pr.text, /^<p>本文です。<\/p>\n<div class="pr-img">/);
  assert.match(pr.text, /data-original-width="1200" data-original-height="630"/);
  assert.deepEqual(pr.images, [{ file_name: "d12345-206-aaa-0.png", file_name_s3: "12345-206-bbb-1200x630.png", caption: "図1" }]);
  assert.equal(pr.image_file_name_main_s3, "12345-206-bbb-1200x630.png");
  // Settings the CLI does not manage are carried over from the current release.
  assert.deepEqual(pr.keywords, ["kept"]);
  assert.equal(pr.mail_body_head_text, "報道関係者各位");
  assert.equal(pr.release_additional_fax_flg, false);
  assert.equal(save.headers.Origin, "https://prtimes.jp");
  assert.match(save.headers.Cookie, /srvssid=sess/);
});

test("draft update refuses releases that are not drafts", async () => {
  const { impl, calls } = fakeFetch(editorRoutes({ ...DRAFT, delivery_status: "released" }));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("# T\n\nbody");
  assert.equal(await main(["draft", "update", "206", file], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "NOT_DRAFT");
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("draft update keeps settings the CLI does not set", async () => {
  const settings = {
    release_type_id: "01",
    busi_cate_id_main: 9,
    busi_cate_id_sub: 11,
    purpose_id: 27,
    reference_url: "https://a.example",
    release_date: "2026-12-01",
    release_time_kbn_2: "1000",
  };
  const { impl, calls } = fakeFetch(editorRoutes({ ...DRAFT, ...settings }));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("# T\n\nbody");
  assert.equal(await main(["draft", "update", "206", file], { client }), 0, err.join("\n"));
  const pr = calls.find((c) => c.method === "PUT")!.body.press_release;
  for (const [k, v] of Object.entries(settings)) assert.equal(pr[k], v, k);
  assert.deepEqual(pr.keywords, ["kept"]);
});

test("draft options prints masters", async () => {
  const { impl } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "options"], { client }), 0, err.join("\n"));
  assert.equal(JSON.parse(out[0]!).releaseTypes[0].id, "01");
});

test("draft settings saves resolved fields and keeps the rest", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const args = ["draft", "settings", "206", "--purpose", "新サービス開始", "--type", "01", "--category", "9", "--keywords", "AI、EC", "--at", "2099-01-01 10:00"];
  assert.equal(await main(args, { client }), 0, err.join("\n"));
  const save = calls.find((c) => c.method === "PUT")!;
  assert.equal(save.path, "/api/press_release_editor.php/press_release/206/auto_save");
  const pr = save.body.press_release;
  assert.equal(pr.purpose_id, 1);
  assert.equal(pr.release_type_id, "01");
  assert.equal(pr.busi_cate_id_main, 9);
  assert.deepEqual(pr.keywords, ["AI", "EC"]);
  assert.equal(pr.release_date, "2099-01-01");
  assert.equal(pr.release_time_kbn_2, "1000");
  assert.equal(pr.mail_body_head_text, "報道関係者各位");
  assert.ok(!("release_send_kbn" in pr));
  assert.equal(JSON.parse(out[0]!).settings.category.name, "システム・Webサイト・アプリ開発");
});

test("draft settings --dry-run sends no PUT", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "settings", "206", "--type", "01", "--dry-run"], { client }), 0, err.join("\n"));
  assert.equal(JSON.parse(out[0]!).dryRun, true);
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("draft settings refuses non-drafts", async () => {
  const { impl, calls } = fakeFetch(editorRoutes({ ...DRAFT, delivery_status: "scheduled" }));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "settings", "206", "--type", "01"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "NOT_DRAFT");
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("draft settings reads settings from frontmatter", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("---\ntitle: T\ntype: 商品サービス\nkeywords: [AI, EC]\n---\n\nbody");
  assert.equal(await main(["draft", "settings", "206", file, "--keywords", "DX"], { client }), 0, err.join("\n"));
  const pr = calls.find((c) => c.method === "PUT")!.body.press_release;
  assert.equal(pr.release_type_id, "01");
  assert.deepEqual(pr.keywords, ["DX"]);
  assert.equal(pr.title, "");
});

test("draft update without settings frontmatter leaves settings alone", async () => {
  const { impl, calls } = fakeFetch(editorRoutes({ ...DRAFT, release_type_id: "01" }));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "update", "206", tempRelease("# T\n\nbody")], { client }), 0, err.join("\n"));
  const pr = calls.find((c) => c.method === "PUT")!.body.press_release;
  assert.equal(pr.release_type_id, "01");
  assert.deepEqual(pr.keywords, ["kept"]);
  assert.ok(!calls.some((c) => c.path.endsWith("/purposes")));
  assert.equal(JSON.parse(out[0]!).settings, undefined);
});

test("draft update applies settings from frontmatter in the same save", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("---\ntitle: T\npurpose: 新サービス開始\ncategory: 流通 > EC・通販\n---\n\nbody");
  assert.equal(await main(["draft", "update", "206", file], { client }), 0, err.join("\n"));
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.body.press_release.title, "T");
  assert.equal(puts[0]!.body.press_release.busi_cate_id_main, 11);
  assert.equal(JSON.parse(out[0]!).settings.purpose.id, 1);
});

test("draft create with an invalid frontmatter category creates nothing", async () => {
  const { impl, calls } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("---\ntitle: T\ncategory: 存在しない\n---\n\nbody");
  assert.equal(await main(["draft", "create", file], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "INVALID_OPTION");
  assert.ok(!calls.some((c) => c.path.endsWith("/press_release/new")));
});

const COMPLETE = {
  ...DRAFT,
  title: "T",
  text: "<p>本文</p>",
  image_file_name_main_s3: "a.png",
  purpose_id: 1,
  release_type_id: "01",
  busi_cate_id_main: 9,
};

/** The release as GET returns it; a PUT to /press_release/206 switches it to `after`. */
function updateRoutes(release: any, after: string): Route[] {
  let status = release.delivery_status;
  return [
    (c) => (c.method === "PUT" && c.path === "/api/press_release_editor.php/press_release/206"
      ? ((status = after), json({ release_id: 206, edit_started_at: 1 }))
      : undefined),
    (c) => (c.method === "GET" && c.path === "/api/press_release_editor.php/press_release/206" ? json({ ...release, delivery_status: status }) : undefined),
    ...editorRoutes(release),
  ];
}

test("draft submit without --yes shows the preview and sends nothing", async () => {
  const { impl, calls } = fakeFetch(updateRoutes(COMPLETE, "scheduled"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--at", "2099-01-01 10:00"], { client }), 1);
  const e = JSON.parse(err[0]!).error;
  assert.equal(e.code, "CONFIRMATION_REQUIRED");
  assert.equal(e.detail.scheduledAt, "2099-01-01 10:00");
  assert.equal(e.detail.settings.purpose.name, "新サービス開始");
  assert.equal(e.detail.distribution, "automatic");
  assert.ok(!calls.some((c) => c.method !== "GET"));
});

test("draft submit --yes sends a scheduled delivery", async () => {
  const { impl, calls } = fakeFetch(updateRoutes(COMPLETE, "scheduled"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--at", "2099-01-01 10:00", "--yes"], { client }), 0, err.join("\n"));
  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.path, "/api/press_release_editor.php/press_release/206");
  const pr = put.body.press_release;
  assert.equal(pr.release_send_kbn, 3);
  assert.equal(pr.release_date, "2099-01-01");
  assert.equal(pr.release_time_kbn_2, "1000");
  assert.equal(pr.release_send_target_type, 2);
  assert.equal(pr.mail_body_head_text, "報道関係者各位");
  assert.equal(put.body.csrf_token, "deadbeef");
  assert.ok(!calls.some((c) => c.body?.press_release?.release_send_kbn === 2));
  const result = JSON.parse(out[0]!);
  assert.equal(result.submitted, true);
  assert.equal(result.status, "scheduled");
  assert.deepEqual(result.warnings, []);
});

test("draft submit uses the saved schedule when --at is omitted", async () => {
  const { impl, calls } = fakeFetch(updateRoutes({ ...COMPLETE, release_date: "2099-02-03", release_time_kbn_2: "930" }, "scheduled"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--yes"], { client }), 0, err.join("\n"));
  const pr = calls.find((c) => c.method === "PUT")!.body.press_release;
  assert.equal(pr.release_date, "2099-02-03");
  assert.equal(pr.release_time_kbn_2, "930");
  assert.equal(JSON.parse(out[0]!).scheduledAt, "2099-02-03 09:30");
});

test("draft submit stops on missing fields", async () => {
  const { impl, calls } = fakeFetch(updateRoutes({ ...COMPLETE, purpose_id: null }, "scheduled"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--at", "2099-01-01 10:00", "--yes"], { client }), 1);
  const e = JSON.parse(err[0]!).error;
  assert.equal(e.code, "INCOMPLETE");
  assert.ok(e.detail.missing.includes("purpose"));
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("draft submit on a scheduled release is refused", async () => {
  const { impl, calls } = fakeFetch(updateRoutes({ ...COMPLETE, delivery_status: "scheduled" }, "scheduled"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--at", "2099-01-01 10:00", "--yes"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "NOT_DRAFT");
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("draft submit warns when status does not change", async () => {
  const { impl } = fakeFetch(updateRoutes(COMPLETE, "draft"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "submit", "206", "--at", "2099-01-01 10:00", "--yes"], { client }), 0, err.join("\n"));
  const result = JSON.parse(out[0]!);
  assert.equal(result.submitted, true);
  assert.equal(result.warnings.length, 1);
});

test("draft unsubmit returns a scheduled release to draft", async () => {
  const { impl, calls } = fakeFetch(updateRoutes({ ...COMPLETE, delivery_status: "scheduled" }, "draft"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "unsubmit", "206"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "CONFIRMATION_REQUIRED");
  assert.equal(calls.length, 0);
  assert.equal(await main(["draft", "unsubmit", "206", "--yes"], { client }), 0, err.join("\n"));
  assert.equal(calls.find((c) => c.method === "PUT")!.body.press_release.release_send_kbn, 1);
  assert.equal(JSON.parse(out[0]!).status, "draft");
});

test("draft unsubmit refuses releases that are not scheduled", async () => {
  const { impl, calls } = fakeFetch(updateRoutes(COMPLETE, "draft"));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "unsubmit", "206", "--yes"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "NOT_SCHEDULED");
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("release get shows setting names", async () => {
  const { impl } = fakeFetch(editorRoutes({ ...COMPLETE, busi_cate_id_sub: 11, release_date: "2099-01-01", release_time_kbn_2: "1000" }));
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["release", "get", "206"], { client }), 0, err.join("\n"));
  const r = JSON.parse(out[0]!);
  assert.equal(r.settings.category.name, "システム・Webサイト・アプリ開発");
  assert.equal(r.settings.subcategory.name, "EC・通販");
  assert.equal(r.settings.purpose.name, "新サービス開始");
  assert.deepEqual(r.settings.keywords, ["kept"]);
  // A draft's saved date is only a placeholder until it is scheduled.
  assert.equal(r.settings.scheduledAt, null);
});

test("release list rejects unknown status", async () => {
  const { impl, calls } = fakeFetch([]);
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["release", "list", "--status", "reserved"], { client }), 2);
  assert.equal(calls.length, 0);
});

test("draft create --dry-run makes no requests", async () => {
  const { impl, calls } = fakeFetch([]);
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  const file = tempRelease("# T\n\n![](a.png)");
  assert.equal(await main(["draft", "create", file, "--dry-run"], { client }), 0);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(out[0]!).images.length, 1);
});

test("draft delete needs --yes", async () => {
  const { impl } = fakeFetch(editorRoutes());
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "delete", "206"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "CONFIRMATION_REQUIRED");
});

test("draft delete --yes deletes through the release list's bulk delete", async () => {
  const { impl, calls } = fakeFetch([
    ...editorRoutes(),
    (c) => (c.method === "DELETE" && c.path === "/api/press_release_list.php/press_releases" ? json(null) : undefined),
  ]);
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["draft", "delete", "206", "--yes"], { client }), 0, err.join("\n"));
  assert.equal(JSON.parse(out[0]!).deleted, true);
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.deepEqual(del.body, { press_release_ids: [206] });
});

test("a 401 is retried once after refreshing the auth token", async () => {
  const fresh = jwt(Date.now() / 1000 + 86400);
  let refreshed = false;
  const { impl, calls } = fakeFetch([
    (c) => {
      if (c.path !== "/auth/token/refresh") return undefined;
      refreshed = true;
      return new Response("", { status: 200, headers: { "set-cookie": `prtimes_auth_token=${fresh}; path=/; secure; HttpOnly` } });
    },
    (c) => (c.path === "/api/press_kit_edit.php/company_user/me"
      ? refreshed
        ? json({ company_id: 1, company_name: "A", first_name: "山田", last_name: "太郎" })
        : new Response(JSON.stringify({ status: 401, message: "You must Login as a company user." }), {
            status: 401,
            headers: { "set-cookie": "prtimes_refresh_token=deleted; Max-Age=0; path=/auth" },
          })
      : undefined),
  ]);
  const s = session({ prtimes_refresh_token: "r1" });
  const client = new PrtimesClient({ session: s, fetchImpl: impl, minIntervalMs: 0 });
  const me = await client.request("/api/press_kit_edit.php/company_user/me");
  assert.equal(me.company_name, "A");
  assert.deepEqual(calls.map((c) => c.path), ["/api/press_kit_edit.php/company_user/me", "/auth/token/refresh", "/api/press_kit_edit.php/company_user/me"]);
  assert.match(calls[1]!.headers.Cookie!, /prtimes_refresh_token=r1/);
  assert.equal(s.cookies.prtimes_auth_token, fresh);
});

test("an expired token without a refresh token reports AUTH_ERROR", async () => {
  const { impl } = fakeFetch([(c) => new Response(JSON.stringify({ message: "You must Login as a company user." }), { status: 401 })]);
  const client = new PrtimesClient({ session: session(), fetchImpl: impl, minIntervalMs: 0 });
  assert.equal(await main(["stats"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "AUTH_ERROR");
});

test("commands need a session", async () => {
  const client = new PrtimesClient({ session: null, fetchImpl: fakeFetch([]).impl, minIntervalMs: 0 });
  assert.equal(await main(["release", "list"], { client }), 1);
  assert.equal(JSON.parse(err[0]!).error.code, "NOT_LOGGED_IN");
});

test("releaseId accepts ids, editor/preview URLs and public URLs", () => {
  assert.equal(releaseId("204"), 204);
  assert.equal(releaseId("https://prtimes.jp/my_c3/action.php?run=mypage&page=pressreleaseedit&release_id=204"), 204);
  assert.equal(releaseId("https://prtimes.jp/main/html/rd/p/000000203.000012345.html"), 203);
  assert.throws(() => releaseId("abc"), /Not a release id/);
});

test("parseImportedCookies requires the session and auth cookies", () => {
  assert.deepEqual(parseImportedCookies("Cookie: srvssid=a; prtimes_auth_token=b; _ga=x"), { srvssid: "a", prtimes_auth_token: "b", _ga: "x" });
  assert.throws(() => parseImportedCookies("srvssid=a"), /prtimes_auth_token/);
});

test("applySetCookies adds, replaces and deletes cookies", () => {
  const h = new Headers();
  h.append("set-cookie", "a=2; path=/");
  h.append("set-cookie", "b=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/");
  assert.deepEqual(applySetCookies({ a: "1", b: "1", c: "1" }, h), { a: "2", c: "1" });
});
