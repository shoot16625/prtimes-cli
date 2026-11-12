import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  missingForSubmit,
  normalizeMasters,
  parseSchedule,
  resolveSettings,
  scheduledAt,
  settingsFromFrontmatter,
} from "../src/settings.ts";
import { parseRelease } from "../src/markdown.ts";
import { RAW_EDITOR, RAW_PURPOSES } from "./fixtures.ts";

const MASTERS = normalizeMasters(RAW_EDITOR, RAW_PURPOSES);
const NOW = new Date("2026-11-12T05:00:00Z");

function code(fn: () => unknown): { code: string; detail: any } {
  try {
    fn();
  } catch (e: any) {
    return { code: e.code, detail: e.detail };
  }
  throw new Error("did not throw");
}

test("resolves names and ids", () => {
  const { fields } = resolveSettings(MASTERS, {}, { purpose: "新サービス開始", type: "1", category: "9", subcategory: "流通 > EC・通販" }, NOW);
  assert.deepEqual(fields, { purpose_id: 1, release_type_id: "01", busi_cate_id_main: 9, busi_cate_id_sub: 11 });
});

test("ambiguous category name lists candidates", () => {
  const e = code(() => resolveSettings(MASTERS, {}, { category: "EC・通販" }, NOW));
  assert.equal(e.code, "INVALID_OPTION");
  assert.deepEqual(e.detail.candidates, ["流通 > EC・通販", "その他 > EC・通販"]);
});

test("unknown name lists candidates", () => {
  const e = code(() => resolveSettings(MASTERS, {}, { type: "商品" }, NOW));
  assert.equal(e.code, "INVALID_OPTION");
  assert.ok(e.detail.candidates.includes("商品サービス"));
});

test("sub equal to main is rejected, also when only main changes", () => {
  const current = { busi_cate_id_main: 9, busi_cate_id_sub: 11 };
  assert.equal(code(() => resolveSettings(MASTERS, current, { category: "11" }, NOW)).code, "INVALID_OPTION");
  assert.equal(resolveSettings(MASTERS, current, { subcategory: "none" }, NOW).fields.busi_cate_id_sub, null);
});

test("keywords split on commas and 、", () => {
  assert.deepEqual(resolveSettings(MASTERS, {}, { keywords: " AI、EC, ,AI,DX " }, NOW).fields.keywords, ["AI", "EC", "DX"]);
  assert.equal(code(() => resolveSettings(MASTERS, {}, { keywords: "あ".repeat(61) }, NOW)).code, "INVALID_INPUT");
});

test("url validation", () => {
  assert.equal(code(() => resolveSettings(MASTERS, {}, { url: "ftp://x" }, NOW)).code, "INVALID_INPUT");
  assert.equal(resolveSettings(MASTERS, {}, { url: "" }, NOW).fields.reference_url, "");
});

test("summary describes the merged result", () => {
  const { summary } = resolveSettings(MASTERS, { release_type_id: "01", keywords: ["x"] }, { category: "システム・Webサイト・アプリ開発" }, NOW);
  assert.deepEqual(summary.type, { id: "01", name: "商品サービス" });
  assert.deepEqual(summary.category, { id: 9, name: "システム・Webサイト・アプリ開発" });
  assert.deepEqual(summary.keywords, ["x"]);
});

test("parseSchedule", () => {
  assert.deepEqual(parseSchedule("2026-11-20 9:00", NOW), { release_date: "2026-11-20", release_time_kbn_2: "0900", at: "2026-11-20 09:00" });
  assert.equal(parseSchedule("2026-11-20T10:00", NOW).release_time_kbn_2, "1000");
  assert.equal(code(() => parseSchedule("2026-11-20 10:05", NOW)).code, "INVALID_INPUT");
  assert.equal(code(() => parseSchedule("2026-11-12 13:00", NOW)).code, "INVALID_INPUT");
  assert.equal(code(() => parseSchedule("2026/11/20 10:00", NOW)).code, "USAGE");
  assert.equal(code(() => parseSchedule("2026-02-30 10:00", NOW)).code, "INVALID_INPUT");
});

test("scheduledAt pads the saved time", () => {
  assert.equal(scheduledAt({ release_date: "2026-11-20", release_time_kbn_2: "930" }), "2026-11-20 09:30");
  assert.equal(scheduledAt({ release_date: null, release_time_kbn_2: "1000" }), null);
});

test("missingForSubmit", () => {
  const ok = {
    title: "T",
    text: "<p>x</p>",
    image_file_name_main_s3: "a.png",
    purpose_id: 1,
    release_type_id: "01",
    busi_cate_id_main: 9,
    release_date: "2026-11-20",
    release_time_kbn_2: "1000",
  };
  assert.deepEqual(missingForSubmit(ok, NOW), []);
  assert.deepEqual(missingForSubmit({ ...ok, purpose_id: null, release_date: "2026-11-12", release_time_kbn_2: "0" }, NOW), [
    "purpose",
    "scheduled time (future)",
  ]);
});

test("settingsFromFrontmatter", () => {
  assert.deepEqual(settingsFromFrontmatter({ title: "x", keywords: "[AI, EC]", scheduledAt: "2026-11-20 10:00" }), {
    keywords: "AI, EC",
    at: "2026-11-20 10:00",
  });
});

test("frontmatter keywords as a YAML block list", () => {
  const fm = parseRelease("---\ntitle: T\nkeywords:\n  - AI\n  - \"SaaS\"\ntype: 01\n---\n\nbody").frontmatter;
  const input = settingsFromFrontmatter(fm);
  assert.equal(input.type, "01");
  assert.deepEqual(resolveSettings(MASTERS, {}, input, NOW).fields.keywords, ["AI", "SaaS"]);
});

test("an empty frontmatter keywords key does not wipe keywords", () => {
  const input = settingsFromFrontmatter(parseRelease("---\ntitle: T\nkeywords:\n---\n\nbody").frontmatter);
  assert.equal(input.keywords, undefined);
});

test("quoted items in a flow list lose their quotes", () => {
  const input = settingsFromFrontmatter(parseRelease('---\nkeywords: ["AI", \'SaaS\']\n---\n\nbody').frontmatter);
  assert.deepEqual(resolveSettings(MASTERS, {}, input, NOW).fields.keywords, ["AI", "SaaS"]);
});
