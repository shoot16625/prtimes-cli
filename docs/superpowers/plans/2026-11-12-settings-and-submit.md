# Release Settings and Scheduled Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let prtimes-cli save a draft's 追加情報 (purpose, type, business categories, keywords, related URL, scheduled time), submit a draft as a 予約配信 (scheduled delivery, which puts it under review), and take a scheduled release back to draft.

**Architecture:** Pure logic (master-data normalization, name→ID resolution, validation, schedule parsing, summaries) lives in a new `src/settings.ts`. `src/api.ts` gains the purposes call, a generic save payload over every field the editor sends, and the `PUT /press_release/{id}` update. `src/cli.ts` gets the commands `draft options`, `draft settings`, `draft submit` and `draft unsubmit`. `draft create` and `draft update` also apply settings from frontmatter.

**Tech Stack:** Bun ≥1.2, TypeScript, `bun:test` with the fake fetch in `test/cli.test.ts`, single-file bundle `dist/prtimes-cli.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-settings-and-submit-design.md` (Japanese; read it, it holds the API facts).

## Global Constraints

- Never send `release_send_kbn: 2` (今すぐ配信). Only 3 (予約配信) for submit and 1 for unsubmit.
- Make no submit/unsubmit request without `--yes`. Without it, throw `CONFIRMATION_REQUIRED` with the preview in `detail`.
- Every save sends every editor field, each taken from the current release unless the user set it. Settings the CLI does not manage must survive.
- Times are Japan time (UTC+9). Minutes must be a multiple of 10. The time must be in the future. `release_date` is `yyyy-MM-dd` and `release_time_kbn_2` is `HHMM` (e.g. `"1000"`, `"0930"`).
- Business category IDs are `lv2` IDs from `GET /press_release/editor` (`business_categories[].lv2[] {id, name}`), and are numbers. `busi_cate_id_sub` may be `null` and must differ from `busi_cate_id_main`. `release_type_id` is a string (`"01"`). `purpose_id` is a number.
- A keyword is at most 60 characters. The related URL is at most 240 characters and must be http(s).
- Distribution target: submit sets `release_send_target_type: 2` (automatic selection).
- Code, skills and manifests are in English. The README is in Japanese.
- After `src/` changes, run `bun run build` and commit `dist/prtimes-cli.js`. `bun run check` must pass.
- Version 0.2.0 in every manifest (`test/manifests.test.ts` enforces it).
- Never submit against the real account during development or E2E (user's instruction).

## Review Focus

1. A keyword list written with `、` or with spaces, empty items or duplicates → split on `,` and `、`, trim, drop empties, dedupe (Task 2 test `keywords split on commas and 、`).
2. A name that doesn't exactly match a master entry, or matches entries in two groups → `INVALID_OPTION`, with candidates in `detail`; `グループ > 名前` picks one (Task 2 tests).
3. Loosely written times (`2026-11-20 9:00`, `2026-11-20T09:00`) are accepted. `2026/11/20 10:00`, `10:05` and past times are rejected with a clear message (Task 2 test `parseSchedule`).
4. `draft update` with frontmatter that has no settings keys leaves existing keywords, type and categories untouched (Task 3 test).
5. `draft submit` on a release that is already scheduled → `NOT_DRAFT`, and no PUT is sent, so nothing is submitted twice (Task 4 test).

---

### Task 1: Save payload carries every editor field

**Files:**
- Modify: `src/api.ts` (`SAVE_FIELDS`, `buildSavePayload`, `defaultValue`, `saveRelease`; add `purposes`, `updateRelease`)
- Modify: `src/cli.ts` (`uploadAndSave` call site)
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces:
  - `SAVE_FIELDS`: the auto_save field list from the spec, in the spec's order (adds `reference_url, gif_animations, release_type_id, busi_cate_id_main, busi_cate_id_sub, mail_title_prefix_flg, mail_title_prefix_text, release_date, release_time_kbn_2, purpose_id, template_id`)
  - `SUBMIT_FIELDS = ["release_send_kbn", ...SAVE_FIELDS]`
  - `buildSavePayload(current: any, overrides: Record<string, unknown>, fields: readonly string[] = SAVE_FIELDS): Record<string, unknown>`. Overrides win. A key present in overrides with value `null` stays `null` (use `key in overrides`, not `??`). Otherwise use the current value, else `defaultValue`. `editor_version` defaults to `"3.0.0"`.
  - `contentFields(c: ReleaseContent): Record<string, unknown>`: maps title/subtitle/text/images/mainImage to their editor keys (what `buildSavePayload` does today).
  - `purposes(client): Promise<any>`: `GET /api/press_release_editor.php/purposes`, returns `data`
  - `updateRelease(client, opts: { releaseId: number; companyId: number; pressRelease: Record<string, unknown> }): Promise<void>`: `PUT /api/press_release_editor.php/press_release/{id}`. The body has the same envelope as `saveRelease` (`csrf_token`, `edit_started_at`, `company_id`, `is_force_mode: false`). Factor the shared CSRF/edit_started_at lookup out of `saveRelease`.
  - `defaultValue`: `gif_animations` → `[]`, `busi_cate_id_*`/`purpose_id`/`template_id` → `null`, `release_type_id`/`reference_url`/`mail_title_prefix_text` → `""`, `release_date`/`release_time_kbn_2` → `null`

- [ ] **Step 1: Write the failing test** `draft update keeps settings the CLI does not set`. Use `DRAFT` extended with `release_type_id: "01", busi_cate_id_main: 9, busi_cate_id_sub: 11, purpose_id: 27, reference_url: "https://a.example", release_date: "2026-12-01", release_time_kbn_2: "1000"`. Run `draft update 206 file`, where the file has only title and body. Assert that the PUT `press_release` has those same seven values, plus `keywords: ["kept"]`.
- [ ] **Step 2: Run it.** `bun test test/cli.test.ts` → FAIL (`release_type_id` undefined).
- [ ] **Step 3: Implement** the Interfaces above. Change `uploadAndSave` to `buildSavePayload(current, api.contentFields({...}))`.
- [ ] **Step 4: Run it.** `bun test` → all pass (24).
- [ ] **Step 5: Commit** `git commit -am "Carry every editor field through saves"`

### Task 2: Settings logic (`src/settings.ts`)

**Files:**
- Create: `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Consumes: `CliError` from `src/client.ts`
- Produces:
  ```ts
  export interface Named<T> { id: T; name: string }
  export interface Masters {
    purposes: { category: string; items: Named<number>[] }[];
    releaseTypes: Named<string>[];
    businessCategories: { group: string; items: Named<number>[] }[];
  }
  export function normalizeMasters(editor: any, purposes: any): Masters;           // editor = editorInfo() data, purposes = api.purposes() data
  export interface SettingsInput { purpose?: string; type?: string; category?: string; subcategory?: string; keywords?: string; url?: string; at?: string }
  export function settingsFromFrontmatter(fm: Record<string, string>): SettingsInput; // keys purpose, type, category, subcategory, keywords, url, scheduledAt (→ at)
  export function hasSettings(s: SettingsInput): boolean;
  export interface SettingsSummary {
    purpose: Named<number> | null; type: Named<string> | null;
    category: Named<number> | null; subcategory: Named<number> | null;
    keywords: string[]; url: string | null; scheduledAt: string | null;   // "YYYY-MM-DD HH:MM" JST
  }
  export function resolveSettings(m: Masters, current: any, input: SettingsInput, now: Date): { fields: Record<string, unknown>; summary: SettingsSummary };
  export function parseSchedule(s: string, now: Date): { release_date: string; release_time_kbn_2: string; at: string };
  export function describeSettings(m: Masters, release: any): SettingsSummary;     // names for IDs already on a release; unknown IDs → { id, name: "(unknown)" }
  export function scheduledAt(release: any): string | null;                        // "YYYY-MM-DD HH:MM" from release_date + release_time_kbn_2.padStart(4,"0"), null if either is missing
  export function missingForSubmit(release: any, now: Date): string[];             // English labels: "title", "body", "main image", "purpose", "type", "business category", "scheduled time (future)"
  ```
- Rules for `resolveSettings` (errors are `CliError("INVALID_OPTION", msg, { detail: { candidates } })` unless noted):
  - Each of purpose/type/category/subcategory accepts an ID (digits; `type` also accepts `"1"` → `"01"` by padding to the master's width) or an exact trimmed name. A category name found in more than one group is ambiguous: candidates are `"group > name"`, and `"group > name"` input resolves it. `subcategory: "none"` → `null`.
  - The resulting sub equals the resulting main → `INVALID_OPTION` (message tells the user to pass `--subcategory`). This applies when only the main changed, too.
  - `keywords`: split on `,` and `、`, trim, drop empties, dedupe keeping order. Any keyword over 60 chars → `INVALID_INPUT`. Replaces the whole list.
  - `url`: `""` clears it. Otherwise it must match `^https?://\S+$` and be ≤240 chars, else `INVALID_INPUT`.
  - `at` → `parseSchedule`.
  - `fields` contains only the keys the user set (`purpose_id`, `release_type_id`, `busi_cate_id_main`, `busi_cate_id_sub`, `keywords`, `reference_url`, `release_date`, `release_time_kbn_2`). `summary` describes the merged result (current + fields).
- `parseSchedule`: accepts `YYYY-MM-DD H:MM`, `YYYY-MM-DD HH:MM`, `YYYY-MM-DDTHH:MM`. Read it as JST: `Date.UTC(y, m-1, d, h-9, min)`. Minutes not a multiple of 10, a nonexistent date (round-trip check) or a time ≤ `now` → `INVALID_INPUT`. Other formats → `USAGE` with the expected format.

- [ ] **Step 1: Write failing tests** in `test/settings.test.ts`. Build the fixture `MASTERS` with `normalizeMasters` from raw shapes copied from the spec: release_types `[{release_type_id:"01",release_type_name:"商品サービス"}]`; business_categories `[{busi_cate_id:"002",busi_cate_name:"企業向けシステム・通信・機器",lv2:[{id:9,name:"システム・Webサイト・アプリ開発"}]},{busi_cate_id:"003",busi_cate_name:"流通",lv2:[{id:11,name:"EC・通販"}]}, {busi_cate_id:"099",busi_cate_name:"その他",lv2:[{id:99,name:"EC・通販"}]}]`; purposes `[{category_name:"マーケティング／PR",purpose_list:[{purpose_id:1,purpose_name:"新サービス開始"}]}]`. Tests:
  - `resolves names and ids`: `{purpose:"新サービス開始", type:"1", category:"9", subcategory:"流通 > EC・通販"}` → fields `{purpose_id:1, release_type_id:"01", busi_cate_id_main:9, busi_cate_id_sub:11}`
  - `ambiguous category name lists candidates`: `{category:"EC・通販"}` throws `INVALID_OPTION`, and `detail.candidates` deep-equals `["流通 > EC・通販","その他 > EC・通販"]`
  - `unknown name lists candidates`: `{type:"商品"}` throws `INVALID_OPTION`, and the candidates include `"商品サービス"`
  - `sub equal to main is rejected, also when only main changes`: current `{busi_cate_id_main:9, busi_cate_id_sub:11}` with `{category:"11"}` throws `INVALID_OPTION`. `{subcategory:"none"}` → `busi_cate_id_sub: null`
  - `keywords split on commas and 、`: `" AI、EC, ,AI,DX "` → `["AI","EC","DX"]`. A 61-character keyword throws `INVALID_INPUT`
  - `url validation`: `"ftp://x"` throws. `""` → `reference_url: ""`
  - `parseSchedule`: with `now = new Date("2026-11-12T05:00:00Z")`, `"2026-11-20 9:00"` → `{release_date:"2026-11-20", release_time_kbn_2:"0900", at:"2026-11-20 09:00"}`. `"2026-11-20T10:00"` is ok. `"2026-11-20 10:05"` throws `INVALID_INPUT`. `"2026-11-12 13:00"` (JST, 04:00Z, past) throws `INVALID_INPUT`. `"2026/11/20 10:00"` throws `USAGE`. `"2026-02-30 10:00"` throws `INVALID_INPUT`
  - `missingForSubmit`: a release with title, text `<p>x</p>`, main image, purpose, type and main category, and release_date/time in the future → `[]`. The same release with `purpose_id:null, release_date:"2026-11-12", release_time_kbn_2:"0"` → `["purpose","scheduled time (future)"]`
  - `settingsFromFrontmatter`: `{keywords:"[AI, EC]", scheduledAt:"2026-11-20 10:00"}` → `{keywords:"AI, EC", at:"2026-11-20 10:00"}` (strip one pair of surrounding `[ ]`)
- [ ] **Step 2: Run them.** `bun test test/settings.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/settings.ts` per the Interfaces.
- [ ] **Step 4: Run them.** `bun test` → all pass.
- [ ] **Step 5: Commit** `git add src/settings.ts test/settings.test.ts && git commit -m "Add release settings resolution and schedule parsing"`

### Task 3: `draft options`, `draft settings`, and settings via frontmatter in create/update

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (add the routes `GET .../press_release/editor` returning the master fixture and `GET .../purposes` to `editorRoutes`)

**Interfaces:**
- Consumes: Task 1 (`buildSavePayload`, `contentFields`, `purposes`, `saveRelease`), Task 2 (all of `settings.ts`)
- Produces:
  - `async function loadMasters(client): Promise<Masters>`: calls `editorInfo` + `purposes` + `normalizeMasters`
  - `SETTINGS_OPTIONS: Options` = `purpose, type, category, subcategory, keywords, url, at` (strings)
  - `draft options` → prints `Masters` as JSON
  - `draft settings <release_id|url> [file.md] [SETTINGS_OPTIONS] [--dry-run]`: flags override frontmatter (`settingsFromFrontmatter(parseRelease(source).frontmatter)`). With no settings given → `USAGE`. Drafts only (`assertDraft`). `--dry-run` returns `{ dryRun: true, releaseId, settings: summary }` without saving. Otherwise it saves with `buildSavePayload(current, fields)` and returns `{ releaseId, settings: summary, editUrl, previewUrl }`.
  - `draft create` / `draft update`: when `hasSettings(frontmatter settings)`, resolve them (the masters are loaded only in that case) and merge the fields into the same single auto_save as the content. The output gains `settings: summary` only in that case. Resolve **before** creating the draft, so that a bad value doesn't leave an empty draft. `--dry-run` includes the resolved `settings`.

- [ ] **Step 1: Write failing tests**:
  - `draft options prints masters` → output has `releaseTypes[0].id === "01"`
  - `draft settings saves resolved fields and keeps the rest`: `draft settings 206 --purpose 新サービス開始 --type 01 --category 9 --keywords "AI、EC" --at "2099-01-01 10:00"` → the PUT auto_save `press_release` has `purpose_id:1, release_type_id:"01", busi_cate_id_main:9, keywords:["AI","EC"], release_date:"2099-01-01", release_time_kbn_2:"1000"`, keeps `mail_body_head_text:"報道関係者各位"`, and has `release_send_kbn` absent
  - `draft settings --dry-run sends no PUT`
  - `draft settings refuses non-drafts` → `NOT_DRAFT`
  - `draft update without settings frontmatter leaves settings alone` (Review Focus 4): `DRAFT` with `release_type_id:"01", keywords:["kept"]`, and a file with only a title → the PUT keeps both, and no GET `/purposes` is made
  - `draft create with an invalid frontmatter category creates nothing` → `INVALID_OPTION`, and no POST `/press_release/new`
- [ ] **Step 2: Run them.** `bun test test/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run them.** `bun test` → all pass.
- [ ] **Step 5: Commit** `git commit -am "Add draft options and draft settings"`

### Task 4: `draft submit` and `draft unsubmit`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (route: `PUT /api/press_release_editor.php/press_release/206` → `json({ edit_started_at: 1 })`. The follow-up GET returns the release with `delivery_status:"scheduled"`. Use a counter so that the GET after the PUT returns the new status.)

**Interfaces:**
- Consumes: Task 1 (`updateRelease`, `buildSavePayload`, `SUBMIT_FIELDS`), Task 2 (`parseSchedule`, `missingForSubmit`, `describeSettings`, `scheduledAt`), Task 3 (`loadMasters`)
- Produces:
  - `draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"] [--yes]`:
    1. `assertDraft`.
    2. If `--at` is given, apply `parseSchedule` to a copy of the release, then run `missingForSubmit` on it. If anything is missing → `CliError("INCOMPLETE", ..., { detail: { missing } })`.
    3. Build `preview = { releaseId, title, scheduledAt, settings: describeSettings(...), distribution: "automatic", previewUrl }`.
    4. Without `--yes` → `CliError("CONFIRMATION_REQUIRED", "Review the submission, then pass --yes to submit it as a scheduled delivery (予約配信). It goes to PR TIMES review.", { detail: preview })`.
    5. With `--yes` → `updateRelease` with `buildSavePayload(current, { ...schedule, release_send_target_type: 2, release_send_kbn: 3 }, SUBMIT_FIELDS)`, then re-fetch.
    6. Return `{ submitted: true, releaseId, scheduledAt, status, editUrl, previewUrl, warnings }`. `warnings` holds `Status is "<x>", not "scheduled". Check with release get; do not submit again.` when the status isn't `scheduled`.
  - `draft unsubmit <release_id|url> --yes`: if the status is not `scheduled` → `NOT_SCHEDULED`. Otherwise `updateRelease` with `buildSavePayload(current, { release_send_kbn: 1 }, SUBMIT_FIELDS)`, re-fetch, and return `{ unsubmitted: true, releaseId, status, warnings }` (warn if the status isn't `draft`). Without `--yes` → `CONFIRMATION_REQUIRED` before any request.

- [ ] **Step 1: Write failing tests**:
  - `draft submit without --yes shows the preview and sends nothing`: a complete draft with `--at "2099-01-01 10:00"` → exit 1, `CONFIRMATION_REQUIRED`, `detail.scheduledAt === "2099-01-01 10:00"`, `detail.settings.purpose.name === "新サービス開始"`, and no PUT made
  - `draft submit --yes sends a scheduled delivery`: the PUT to `/press_release/206` has `press_release.release_send_kbn === 3`, `release_date:"2099-01-01"`, `release_time_kbn_2:"1000"`, `release_send_target_type: 2`, `csrf_token:"deadbeef"`; the output `status === "scheduled"` and `warnings` is empty. Also assert that no request body anywhere has `release_send_kbn: 2`
  - `draft submit stops on missing fields`: a draft without `purpose_id` → `INCOMPLETE`, `detail.missing` includes `"purpose"`, and no PUT
  - `draft submit on a scheduled release is refused` (Review Focus 5) → `NOT_DRAFT`, and no PUT
  - `draft submit warns when status does not change`: the GET after the PUT still returns `draft` → exit 0, with one warning
  - `draft unsubmit returns a scheduled release to draft`: the PUT has `release_send_kbn === 1`. On a draft → `NOT_SCHEDULED`
- [ ] **Step 2: Run them.** `bun test test/cli.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the Interfaces.
- [ ] **Step 4: Run them.** `bun test` → all pass.
- [ ] **Step 5: Commit** `git commit -am "Add draft submit (scheduled delivery only) and draft unsubmit"`

### Task 5: `release get` names, `release list --status` values

**Files:**
- Modify: `src/cli.ts` (`release get`, `release list`), `src/api.ts` (`DELIVERY_STATUSES` → the spec's eight values)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `loadMasters`, `describeSettings`, `scheduledAt`
- Produces: `release get` adds `settings: SettingsSummary` (it replaces `releaseTypeId`, `businessCategoryIds` and `keywords`; `scheduledAt` is set only when the status is `scheduled`, otherwise `null`). `release list` usage lists `draft|scheduled|released|withdrawn_by_review|...` from `DELIVERY_STATUSES`, and an unknown `--status` → `USAGE`.

- [ ] **Step 1: Write failing tests**: `release get shows setting names` (`settings.category.name === "システム・Webサイト・アプリ開発"`); `release list rejects unknown status` (`--status reserved` → exit 2).
- [ ] **Step 2: Run them** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** `bun test` → pass.
- [ ] **Step 5: Commit** `git commit -am "Show setting names in release get and fix status values"`

### Task 6: Skills, README, version 0.2.0, bundle

**Files:**
- Modify: `skills/draft/SKILL.md`, `skills/releases/SKILL.md`, `README.md`, `package.json` and every manifest listed in `test/manifests.test.ts`, `dist/prtimes-cli.js`

- [ ] **Step 1: `skills/draft/SKILL.md`**: add a "Settings and submission" section.
  - The workflow: run `draft options` and read the body → propose the purpose, type, category (+ optional second category) and 5–10 keywords to the user → after they agree, `draft settings` → submit only when the user explicitly asks and gives a time. First run `draft submit` without `--yes` and show the user the `detail`. Run it with `--yes` only after they confirm.
  - Never retry a submit. Check with `release get`.
  - Immediate delivery is not possible. Use `draft unsubmit` to take a release back to draft.
  - The submit/unsubmit request shape was not exercised against the live service during development, so report any error verbatim.
  - Document the frontmatter keys and add `NOT_SCHEDULED`, `INCOMPLETE` and `INVALID_OPTION` to the error list. Keep the description line short (the descriptions were compressed in #6).
- [ ] **Step 2: `skills/releases/SKILL.md`**: fix the statuses (`scheduled`) and mention `settings` in `release get`.
- [ ] **Step 3: `README.md`** (Japanese):
  - Change 「審査への申請と配信はしません」 to 「予約配信での申請まで（今すぐ配信はしない）」.
  - Add the new commands, the frontmatter keys (`purpose`, `type`, `category`, `subcategory`, `keywords`, `url`, `scheduledAt`) and the note about live verification.
  - Update 「未対応の機能」: 今すぐ配信, 位置情報, フッター, メディアリストの手動選択, メール設定.
- [ ] **Step 4: Bump to 0.2.0** in `package.json` and all manifests. Then `bun run build`.
- [ ] **Step 5: Verify.** `bun run typecheck && bun test && bun run build` → pass.
- [ ] **Step 6: Commit** `git add -A && git commit -m "Document settings and scheduled submission; release 0.2.0"`. Then `bun run check` → exit 0.

### Task 7: Live E2E (with the user present, no submission)

- [ ] **Step 1:** `bun dist/prtimes-cli.js draft options` → it lists real masters.
- [ ] **Step 2:** Create a test draft from a scratch Markdown file with an image: `draft create`.
- [ ] **Step 3:** `draft settings <id> --purpose <a real name> --type 01 --category <id> --subcategory <id> --keywords "テスト、prtimes-cli" --url https://example.com --at "<a date ~1 month out> 10:00"`.
- [ ] **Step 4:** In the browser (Chrome DevTools MCP), open the edit page, click 次へ, and confirm that the values appear on 追加情報設定 and that the date and time appear on 配信詳細設定. **Do not press any 申請/配信 button.**
- [ ] **Step 5:** `release get <id>` → the settings names are as set.
- [ ] **Step 6:** `draft submit <id>` (no `--yes`) → `CONFIRMATION_REQUIRED` with the preview. Confirm with `release get` that the status is still `draft`.
- [ ] **Step 7:** `draft delete <id> --yes`.
- [ ] **Step 8:** Push the branch and run `gh pr create --assignee @me`. The PR body must say that submit/unsubmit were not run live.
