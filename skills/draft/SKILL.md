---
name: draft
description: Save, update or delete PR TIMES press release drafts from Markdown (images, main image, headings, lists, YouTube).
---

# prtimes-cli:draft

Save press releases to PR TIMES as drafts through the unofficial API wrapper `prtimes-cli`. Drafts are private. prtimes-cli never submits a release for review or delivers it: categories, keywords, delivery date, media lists and 「申請」 stay in the PR TIMES admin screen, so give the user the `editUrl` when the draft is ready.

## Running prtimes-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/prtimes-cli.js` (requires [Bun](https://bun.sh)).

- If `prtimes-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/prtimes-cli.js` exists, run `bun <plugin root>/dist/prtimes-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/prtimes-cli`, then use `prtimes-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`). Below, `prtimes-cli` means whichever of these works.

Output is JSON on stdout. Errors are JSON on stderr (`{"error": {"code", "message"}}`) with exit code 1 (2 for usage errors). Codes: `NOT_LOGGED_IN`, `AUTH_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `NOT_DRAFT` (the release is scheduled, delivered or withdrawn; prtimes-cli only edits drafts), `CONFIRMATION_REQUIRED`, `INVALID_INPUT`, `RATE_LIMITED`, `API_ERROR`, `USAGE`.

## Login

`prtimes-cli auth status` tells you whether a session exists. To log in, run `prtimes-cli auth login` yourself with a command timeout of at least 300 seconds. It opens a Chrome/Edge/Chromium window on the PR TIMES company login page and waits for the user to log in there. Tell the user to log in in that window. Never ask for their password. The session renews itself for as long as PR TIMES allows; when it finally expires, commands fail with `AUTH_ERROR` and the user logs in again. If no browser is found, pass `--browser <path>`, or have the user copy the `Cookie` request header of any logged-in prtimes.jp request from DevTools (Network tab) and pipe it to `prtimes-cli auth import` (that session cannot renew itself and lasts about a day).

## Commands

```bash
prtimes-cli draft create release.md --dry-run      # preview converted HTML, images + warnings, no network
prtimes-cli draft create release.md [--main-image main.png]   # -> {releaseId, editUrl, previewUrl, mainImage, warnings}
prtimes-cli draft update <release_id|url> release.md          # overwrite title, subtitle, body and images of a draft
prtimes-cli draft delete <release_id|url> --yes               # drafts only; ask the user first
prtimes-cli release get <release_id|url>                      # read it back as text (--html for raw)
```

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
- `draft update` keeps everything the CLI does not set (categories, keywords, delivery settings, media lists) as they are in the draft.

## Workflow

1. Write or edit the Markdown file with the user. A typical release opens with a bold lead paragraph (「株式会社〇〇（本社：…、代表取締役：…）は、…」), then `##` sections, and ends with a company overview and contact section.
2. Run `draft create … --dry-run` and fix any warnings.
3. Check login with `prtimes-cli auth status`, then run `draft create` (or `draft update <release_id>` to revise).
4. Give the user the `previewUrl` to check the layout and the `editUrl` to set categories and delivery and submit it for review in the admin screen.
