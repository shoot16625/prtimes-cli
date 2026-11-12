---
name: draft
description: Save PR TIMES press release drafts from Markdown, set their type, categories and keywords, and submit them as scheduled deliveries.
---

# prtimes-cli:draft

Save press releases to PR TIMES as drafts, fill in their 追加情報 (purpose, type, business categories, keywords, related URL) and scheduled time, and submit them as a 予約配信 (scheduled delivery) through the unofficial API wrapper `prtimes-cli`. Drafts are private. A scheduled delivery goes to PR TIMES review and is published at the scheduled time once approved. prtimes-cli never delivers immediately (今すぐ配信). Media lists are always selected automatically. Location, footer and e-mail settings stay in the admin screen.

## Running prtimes-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/prtimes-cli.js` (requires [Bun](https://bun.sh)).

- If `prtimes-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/prtimes-cli.js` exists, run `bun <plugin root>/dist/prtimes-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/prtimes-cli`, then use `prtimes-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `prtimes-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `NOT_DRAFT` (the release is scheduled, delivered or withdrawn; prtimes-cli only edits drafts), `NOT_SCHEDULED`, `CONFIRMATION_REQUIRED`, `INCOMPLETE` (`detail.missing` lists what a submission lacks), `INVALID_OPTION` (`detail.candidates` lists valid names), `INVALID_INPUT`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login

`prtimes-cli auth status` tells you whether a session exists. To log in, run `prtimes-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the PR TIMES company login page and waits for the user to log in there. Tell the user to log in in that window. Never ask for their password. The session renews itself for as long as PR TIMES allows; when it finally expires, commands fail with `AUTH_ERROR` and the user logs in again. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header of any logged-in prtimes.jp request from DevTools (Network tab) and pipe it to `prtimes-cli auth import` (that session cannot renew itself and lasts about a day).

## Commands

```bash
prtimes-cli draft create release.md --dry-run      # preview converted HTML, images + warnings, no network
prtimes-cli draft create release.md [--main-image main.png]   # -> {releaseId, editUrl, previewUrl, mainImage, warnings}
prtimes-cli draft update <release_id|url> release.md          # overwrite title, subtitle, body and images of a draft
prtimes-cli draft delete <release_id|url> --yes               # drafts only; ask the user first
prtimes-cli release get <release_id|url>                      # read it back as text (--html for raw), with setting names

prtimes-cli draft options                                     # purposes, release types, business categories (ids + names)
prtimes-cli draft settings <release_id|url> [release.md] [--purpose P] [--type T] [--category C] [--subcategory C|none] [--keywords "a,b"] [--url U] [--at "YYYY-MM-DD HH:MM"] [--dry-run]
prtimes-cli draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"]        # shows what would be sent (CONFIRMATION_REQUIRED, see detail)
prtimes-cli draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"] --yes  # submit as 予約配信; only when the user asked
prtimes-cli draft unsubmit <release_id|url> --yes            # take a scheduled release back to draft
```

## Settings

- `--purpose`, `--type`, `--category`, `--subcategory` take an id or the exact name from `draft options`. Business categories are the fine-grained entries (`businessCategories[].items`); `--category` (required before submitting) and `--subcategory` (optional) are two separate categories and must differ. If a name exists in two groups, write `"group > name"`. `--subcategory none` clears it.
- `--keywords` replaces the whole list; separate with `,` or `、`, max 60 characters each. `--url` is the related URL (http(s), max 240; `""` clears it).
- `--at` is Japan time in 10-minute steps and must be in the future. With `draft settings` it only saves the date and time (the release stays a draft). Editing the draft in the admin screen resets a saved time, so prefer passing `--at` to `draft submit` itself.
- The same keys work in the Markdown frontmatter (`purpose:`, `type:`, `category:`, `subcategory:`, `keywords: [a, b]`, `url:`, `scheduledAt:`) for `draft create`, `draft update` and `draft settings <id> release.md`. Options override frontmatter. Settings you do not pass keep their current values.
- Submitting needs a title, body, main image, purpose, type, business category and a future scheduled time; `INCOMPLETE` says what is missing.

## Markdown → PR TIMES conversion

- Title: frontmatter `title:`, else the first `# Heading` (removed from the body), or `--title`. Max 100 characters. Subtitle: frontmatter `subtitle:` or `--subtitle` (max 100).
- `#`/`##` → 中見出し, `###` → 小見出し, `####`+ → bold line.
- Single newlines are kept as line breaks; blank lines separate paragraphs. Bold, italic, links, bulleted and numbered lists and horizontal rules work.
- `> quote` → 囲み (boxed text). A paragraph starting with `※` → 注釈 (small annotation text).
- **Local images** (`![](img/a.png "caption")`, path relative to the Markdown file) are uploaded; the optional title becomes the caption. PNG/JPEG/GIF, ≤ 10 MB, up to 30. Put each image on its own line. Image URLs are not uploaded (they become links, with a warning).
- **Main image** (メイン画像): `--main-image <file>` or frontmatter `mainImage:`; otherwise the first body image. PR TIMES needs one before delivery; 1200x630 or larger landscape images look best.
- A YouTube URL alone on its own line becomes a YouTube embed.
- Code blocks and tables have no equivalent and are degraded with a warning (tables become one paragraph per row). Raw HTML is escaped.
- The body limit is 8000 characters; a warning says when it is exceeded.
- `draft update` keeps everything the CLI does not set (settings not in the frontmatter, delivery settings, media lists) as they are in the draft.

## Workflow

1. Write or edit the Markdown file with the user. A typical release opens with a bold lead paragraph (「株式会社〇〇（本社：…、代表取締役：…）は、…」), then `##` sections, and ends with a company overview and contact section.
2. Run `draft create … --dry-run` and fix any warnings.
3. Check login with `prtimes-cli auth status`, then run `draft create` (or `draft update <release_id>` to revise).
4. Give the user the `previewUrl` to check the layout.
5. Settings: run `draft options`, read the release, and propose a purpose, a type, a business category (plus an optional second one) and 5–10 keywords that readers and journalists would search for. Show the proposal to the user and save it with `draft settings` only after they agree. Keywords are chosen per release; do not reuse a fixed list.
6. Submit only when the user explicitly asks for it and gives (or confirms) the delivery time. Run `draft submit <id> --at "…"` without `--yes` first and show the user the `detail` (title, scheduled time, settings, automatic media selection, preview URL). Run it again with `--yes` only after they confirm.
7. After `--yes`, report `status` (`scheduled` means it is under PR TIMES review). If there is a warning, check with `release get`; never submit again on your own. To cancel, use `draft unsubmit <id> --yes`.

The submit and unsubmit requests mirror what the admin screen sends, but they were not run against the live service while prtimes-cli was developed. If one fails, report the error verbatim and point the user to the `editUrl`.
