---
name: releases
description: List and read your company's PR TIMES press releases and check dashboard numbers (page views, reprints, followers).
---

# prtimes-cli:releases

Look up the logged-in company's PR TIMES press releases and dashboard numbers with the unofficial API wrapper `prtimes-cli`. Everything here is read-only.

## Running prtimes-cli

This skill ships with the CLI. This file lives at `<plugin root>/skills/<skill>/SKILL.md`; the CLI is a dependency-free bundle at `<plugin root>/dist/prtimes-cli.js` (requires [Bun](https://bun.sh)).

- If `prtimes-cli` is on PATH, use it.
- Otherwise, if `<plugin root>/dist/prtimes-cli.js` exists, run `bun <plugin root>/dist/prtimes-cli.js ...` with the absolute path.
- Otherwise (the skill was installed on its own, e.g. with `npx skills add`), ask the user before installing the CLI globally with `bun add -g github:shoot16625/prtimes-cli`, then use `prtimes-cli`.
- If `bun` is missing, ask the user to install it (`curl -fsSL https://bun.sh/install | bash`).

Output is JSON on stdout; errors are JSON on stderr with exit code 1. If a command fails with `NOT_LOGGED_IN` or `AUTH_ERROR`, follow the Login section of the `prtimes-cli:draft` skill (`prtimes-cli auth login`, run with a timeout of at least 300 seconds; never ask for the password).

## Commands

```bash
prtimes-cli release list [--page N] [--limit N] [--search <phrase>] [--status draft|scheduled|released|withdrawn_by_review|...]
prtimes-cli release get <release_id|url> [--html] [--max-chars N]   # title, body as text, images, settings (purpose, type, categories, keywords) with names, status, URLs
prtimes-cli stats            # last month: page views, visitors, reprints (転載), followers, device split, top 3 by PV and by social
prtimes-cli auth status      # which company the session belongs to, and its plan
```

- `release list` returns `pager` (`total`, `last_page`) and per release `releaseId`, `title`, `status`, `date`, `url` (public URL once delivered) and `editUrl`. `--status` filters the fetched page only; page through with `--page` when looking for older ones.
- `release get` accepts a release id, an admin edit/preview URL or a public `prtimes.jp/main/html/rd/p/....html` URL of your own company. Bodies are cut at 20000 characters by default (`truncated: true`).
- `stats` covers the dashboard's fixed 「直近1か月間」 window and sums press releases and stories.
