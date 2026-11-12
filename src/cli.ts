import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as api from "./api.ts";
import { CliError, PrtimesClient } from "./client.ts";
import { isLocalImageRef, readImage, resolveImagePath, sizeFromS3Name, type ImageFile } from "./images.ts";
import { browserLogin } from "./login.ts";
import {
  SUBTITLE_MAX,
  TITLE_MAX,
  htmlToText,
  imageRefs,
  markdownToPrtimesHtml,
  parseRelease,
  type BodyImage,
} from "./markdown.ts";
import { AUTH_COOKIE, REFRESH_COOKIE, SESSION_COOKIE, clearSession, loadSession, parseCookieHeader, saveSession, sessionPath } from "./session.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

export interface Deps {
  client?: PrtimesClient;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  /** minimum number of positional args */
  args?: number;
  run(ctx: { values: Values; positionals: string[]; client: PrtimesClient }): Promise<unknown>;
}

const DEFAULT_MAX_CHARS = "20000";
const CONTENT_OPTIONS: Options = {
  title: { type: "string" },
  subtitle: { type: "string" },
  "main-image": { type: "string" },
  "dry-run": { type: "boolean" },
};

const COMMANDS: Record<string, Command> = {
  // ---------------- auth ----------------
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
            await api.currentUser(new PrtimesClient({ session: { cookies: c, savedAt: "probe" } }));
            return true;
          } catch {
            return false;
          }
        },
      });
      return finishLogin(cookies);
    },
  },
  "auth import": {
    usage: "auth import [--cookie '<Cookie request header>']   (or pipe it via stdin)",
    summary: "Save a session from the Cookie request header of a logged-in prtimes.jp request (copied from browser DevTools)",
    options: { cookie: { type: "string" } },
    async run({ values }) {
      const raw = typeof values.cookie === "string" ? values.cookie : await readStdin();
      return finishLogin(parseImportedCookies(raw));
    },
  },
  "auth status": {
    usage: "auth status",
    summary: "Show whether the saved session is valid and which company it belongs to",
    async run({ client }) {
      const session = await loadSession();
      if (!session) return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const me = await api.currentUser(client);
        return {
          loggedIn: true,
          companyId: me.company_id,
          companyName: me.company_name,
          // PR TIMES stores the family name in first_name.
          user: `${me.first_name} ${me.last_name}`.trim(),
          plan: me.plan_name,
          canRefresh: Boolean(session.cookies[REFRESH_COOKIE]),
          savedAt: session.savedAt,
        };
      } catch (e) {
        if (e instanceof CliError && (e.code === "AUTH_ERROR" || e.code === "NOT_LOGGED_IN")) {
          return { loggedIn: false, reason: e.message, sessionPath: sessionPath() };
        }
        throw e;
      }
    },
  },
  "auth logout": {
    usage: "auth logout",
    summary: "Delete the saved session file",
    async run() {
      return { removed: await clearSession(), sessionPath: sessionPath() };
    },
  },

  // ---------------- releases ----------------
  "release list": {
    usage: "release list [--page <n>] [--limit <n>] [--search <phrase>] [--status draft|reserved|released|withdrawn_by_review]",
    summary: "List your company's press releases (drafts, scheduled, delivered), newest first",
    options: {
      page: { type: "string", default: "1" },
      limit: { type: "string", default: "20" },
      search: { type: "string" },
      status: { type: "string" },
    },
    async run({ values, client }) {
      const res = await api.listReleases(client, {
        page: int(values.page, "page"),
        limit: int(values.limit, "limit"),
        search: typeof values.search === "string" ? values.search : undefined,
      });
      const items = res.items
        .map((r) => ({
          releaseId: r.release_id,
          title: r.title,
          status: r.delivery_status,
          date: r.display_date,
          feeStatus: r.fee_status,
          mainImageUrl: r.main_image_url,
          url: r.delivery_status === "released" ? api.publicUrl(r.company_id, r.release_id) : null,
          editUrl: api.editUrl(r.release_id),
        }))
        .filter((r) => (values.status ? r.status === values.status : true));
      return { pager: res.pager, count: items.length, releases: items };
    },
  },
  "release get": {
    usage: "release get <release_id|url> [--html] [--max-chars <n>]",
    summary: "Read a release (title, body, images, categories, status) as the editor holds it",
    options: { html: { type: "boolean" }, "max-chars": { type: "string", default: DEFAULT_MAX_CHARS } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      const r = await api.getRelease(client, id);
      if (!r || typeof r !== "object") throw new CliError("NOT_FOUND", `Release ${id} not found.`);
      return {
        releaseId: r.release_id,
        companyId: r.company_id,
        status: r.delivery_status,
        title: r.title,
        subtitle: r.subtitle,
        releaseDate: r.release_date,
        releaseTypeId: r.release_type_id || null,
        businessCategoryIds: [r.busi_cate_id_main, r.busi_cate_id_sub].filter((x) => x != null),
        keywords: r.keywords ?? [],
        mainImage: r.image_file_name_main_s3 ?? null,
        images: (r.images ?? []).length,
        editUrl: api.editUrl(r.release_id),
        previewUrl: api.previewUrl(r.company_id, r.release_id),
        url: r.delivery_status === "released" ? api.publicUrl(r.company_id, r.release_id) : null,
        ...bodyField(String(r.text ?? ""), Boolean(values.html), int(values["max-chars"], "max-chars")),
      };
    },
  },

  // ---------------- drafts ----------------
  "draft create": {
    usage: "draft create <file.md|-> [--title <t>] [--subtitle <s>] [--main-image <file>] [--dry-run]",
    summary: "Create a new draft from Markdown; local images are uploaded, the first one becomes the main image unless --main-image is given",
    options: CONTENT_OPTIONS,
    args: 1,
    async run({ values, positionals, client }) {
      const input = await readInput(positionals[0]!, values);
      if (values["dry-run"]) return dryRun(input);
      const id = await api.createRelease(client);
      try {
        const saved = await uploadAndSave(client, id, input);
        return { created: true, ...saved };
      } catch (e) {
        if (e instanceof CliError) {
          throw new CliError(e.code, `${e.message} (An empty draft ${id} was created; fix the problem and run \`draft update ${id}\`.)`, {
            status: e.status,
            detail: e.detail,
          });
        }
        throw e;
      }
    },
  },
  "draft update": {
    usage: "draft update <release_id|url> <file.md|-> [--title <t>] [--subtitle <s>] [--main-image <file>] [--dry-run]",
    summary: "Overwrite a draft's title, subtitle, body and images with Markdown (drafts only)",
    options: CONTENT_OPTIONS,
    args: 2,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      const input = await readInput(positionals[1]!, values);
      if (values["dry-run"]) return dryRun(input);
      return { updated: true, ...(await uploadAndSave(client, id, input)) };
    },
  },
  "draft delete": {
    usage: "draft delete <release_id|url> --yes",
    summary: "Delete a draft (drafts only)",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to delete the draft.");
      const current = await api.getRelease(client, id);
      assertDraft(current, id);
      await api.deleteRelease(client, id);
      return { deleted: true, releaseId: id, title: current.title };
    },
  },

  // ---------------- stats ----------------
  stats: {
    usage: "stats",
    summary: "Dashboard numbers for the last month: page views, visitors, reprints, followers, top releases",
    async run({ client }) {
      const s = await api.dashboardStats(client);
      return { recentMonth: s.recentMonth, topPageViews: s.topPageViews, topSocial: s.topSocial };
    },
  },
};

// ---------------- draft helpers ----------------

interface Input {
  title: string;
  subtitle: string;
  markdown: string;
  baseDir: string;
  /** Local image files in the body, keyed by their Markdown src. */
  images: Map<string, ImageFile>;
  mainImage: ImageFile | null;
  warnings: string[];
}

async function readInput(file: string, values: Values): Promise<Input> {
  const source = file === "-" ? await readStdin() : await readFile(file, "utf8").catch(() => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}.`);
  });
  const baseDir = file === "-" ? process.cwd() : dirname(resolve(file));
  const parsed = parseRelease(source);
  const title = (typeof values.title === "string" ? values.title : parsed.title)?.trim();
  const subtitle = (typeof values.subtitle === "string" ? values.subtitle : parsed.subtitle ?? "").trim();
  if (!title) throw new CliError("INVALID_INPUT", "No title: add frontmatter `title:`, a first `# Heading`, or --title.");
  if ([...title].length > TITLE_MAX) throw new CliError("INVALID_INPUT", `Title is ${[...title].length} characters; PR TIMES allows ${TITLE_MAX}.`);
  if ([...subtitle].length > SUBTITLE_MAX) throw new CliError("INVALID_INPUT", `Subtitle is ${[...subtitle].length} characters; PR TIMES allows ${SUBTITLE_MAX}.`);

  const warnings: string[] = [];
  const images = new Map<string, ImageFile>();
  for (const src of imageRefs(parsed.markdown)) {
    if (!isLocalImageRef(src)) continue;
    images.set(src, await readImage(resolveImagePath(src, baseDir)));
  }
  const mainRef =
    typeof values["main-image"] === "string"
      ? resolve(values["main-image"])
      : (parsed.frontmatter.mainImage ?? parsed.frontmatter.main_image)
        ? resolveImagePath((parsed.frontmatter.mainImage ?? parsed.frontmatter.main_image)!, baseDir)
        : null;
  const mainImage = mainRef ? await readImage(mainRef) : null;
  if (!mainImage && images.size === 0) warnings.push("No main image (メイン画像). PR TIMES needs one before delivery; pass --main-image or add an image.");
  return { title, subtitle, markdown: parsed.markdown, baseDir, images, mainImage, warnings };
}

function dryRun(input: Input) {
  const placeholder = new Map<string, BodyImage>([...input.images.keys()].map((src) => [src, { file_name: `(upload) ${src}`, file_name_s3: `(upload) ${src}` }]));
  const converted = markdownToPrtimesHtml(input.markdown, { images: placeholder });
  return {
    dryRun: true,
    title: input.title,
    subtitle: input.subtitle,
    textLength: converted.textLength,
    images: [...input.images.values()].map((i) => i.path),
    mainImage: input.mainImage?.path ?? [...input.images.values()][0]?.path ?? null,
    html: converted.html,
    warnings: [...input.warnings, ...converted.warnings],
  };
}

async function uploadAndSave(client: PrtimesClient, id: number, input: Input) {
  const current = await api.getRelease(client, id);
  assertDraft(current, id);

  // Upload each distinct file once.
  const byPath = new Map<string, api.UploadedImage>();
  const upload = async (img: ImageFile) => {
    const done = byPath.get(img.path);
    if (done) return done;
    const up = await api.uploadImage(client, id, img);
    byPath.set(img.path, up);
    return up;
  };
  const bodyImages = new Map<string, BodyImage>();
  for (const [src, img] of input.images) {
    const up = await upload(img);
    bodyImages.set(src, { ...up, ...sizeFromS3Name(up.file_name_s3) });
  }
  const converted = markdownToPrtimesHtml(input.markdown, { images: bodyImages });
  const main = input.mainImage ? await upload(input.mainImage) : (converted.images[0] ?? null);

  const payload = api.buildSavePayload(current, {
    title: input.title,
    subtitle: input.subtitle,
    text: converted.html,
    images: converted.images,
    mainImage: main ? { file_name: main.file_name, file_name_s3: main.file_name_s3 } : null,
  });
  await api.saveRelease(client, { releaseId: id, companyId: current.company_id, pressRelease: payload });
  return {
    releaseId: id,
    title: input.title,
    subtitle: input.subtitle,
    textLength: converted.textLength,
    images: converted.images.length,
    mainImage: main?.file_name_s3 ?? null,
    editUrl: api.editUrl(id),
    previewUrl: api.previewUrl(current.company_id, id),
    warnings: [...input.warnings, ...converted.warnings],
  };
}

function assertDraft(release: any, id: number) {
  if (!release || typeof release !== "object") throw new CliError("NOT_FOUND", `Release ${id} not found.`);
  if (release.delivery_status !== "draft") {
    throw new CliError("NOT_DRAFT", `Release ${id} is "${release.delivery_status}", not a draft. prtimes-cli only edits drafts; change it in the admin screen.`);
  }
}

/** Accept a release id, an edit/preview URL (release_id=N) or a public URL (rd/p/000000204.000012345.html). */
export function releaseId(ref: string): number {
  const s = ref.trim();
  const m = s.match(/^\d+$/) ? [s, s] : (s.match(/[?&]release_id=(\d+)/) ?? s.match(/\/rd\/p\/0*(\d+)\.\d+\.html/));
  const id = Number(m?.[1]);
  if (!Number.isInteger(id) || id <= 0) throw new CliError("USAGE", `Not a release id or PR TIMES release URL: ${ref}`);
  return id;
}

// ---------------- auth helpers ----------------

async function finishLogin(cookies: Record<string, string>) {
  const client = new PrtimesClient({ session: { cookies, savedAt: "probe" } });
  const me = await api.currentUser(client);
  const path = await saveSession({ cookies, companyId: me.company_id, companyName: me.company_name, savedAt: new Date().toISOString() });
  return {
    loggedIn: true,
    companyId: me.company_id,
    companyName: me.company_name,
    canRefresh: Boolean(cookies[REFRESH_COOKIE]),
    sessionPath: path,
  };
}

/** A Cookie header copied from DevTools must carry the PHP session and the auth JWT. */
export function parseImportedCookies(raw: string): Record<string, string> {
  const cookies = parseCookieHeader(raw.trim());
  if (!cookies[SESSION_COOKIE] || !cookies[AUTH_COOKIE]) {
    throw new CliError("INVALID_INPUT", `Expected a Cookie header containing ${SESSION_COOKIE} and ${AUTH_COOKIE}.`);
  }
  return cookies;
}

// ---------------- generic helpers ----------------

function bodyField(html: string, asHtml: boolean, maxChars: number) {
  const full = asHtml ? html : htmlToText(html);
  const chars = [...full];
  const truncated = maxChars > 0 && chars.length > maxChars;
  const body = truncated ? chars.slice(0, maxChars).join("") : full;
  return { ...(asHtml ? { bodyHtml: body } : { bodyText: body }), bodyChars: chars.length, truncated };
}

function int(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new CliError("USAGE", `--${name} must be a non-negative integer.`);
  return n;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError("USAGE", "Expected input on stdin.");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function helpText(): string {
  return [
    "prtimes-cli — unofficial PR TIMES CLI (JSON output)",
    "",
    "Usage: prtimes-cli <command> [options]",
    "",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage}\n      ${c.summary}`),
    "",
    "Env: PRTIMES_COOKIE (Cookie header, overrides saved session), PRTIMES_CLI_HOME, PRTIMES_CLI_INTERVAL_MS, PRTIMES_CLI_DEBUG, PRTIMES_CLI_BROWSER",
  ].join("\n");
}

function findCommand(argv: string[]): { cmd: Command; rest: string[] } | null {
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { cmd: COMMANDS[two], rest: argv.slice(2) };
  if (argv[0] && COMMANDS[argv[0]]) return { cmd: COMMANDS[argv[0]], rest: argv.slice(1) };
  return null;
}

export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    console.log(helpText());
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    const group = Object.values(COMMANDS).filter((c) => c.usage.startsWith(`${argv[0]} `));
    console.error(group.length ? group.map((c) => `prtimes-cli ${c.usage}`).join("\n") : `Unknown command: ${argv[0]}\n\n${helpText()}`);
    return 2;
  }
  const { cmd, rest } = found;
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`prtimes-cli ${cmd.usage}\n  ${cmd.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: cmd.options ?? {}, allowPositionals: true, strict: true });
    if (positionals.length < (cmd.args ?? 0)) throw new CliError("USAGE", `Usage: prtimes-cli ${cmd.usage}`);
    const client = deps.client ?? new PrtimesClient();
    const result = await cmd.run({ values: values as Values, positionals, client });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      console.error(JSON.stringify({ error: { code: e.code, message: e.message, status: e.status, detail: e.detail } }, null, 2));
      return e.code === "USAGE" ? 2 : 1;
    }
    if ((e as NodeJS.ErrnoException).code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(`${(e as Error).message}\nUsage: prtimes-cli ${cmd.usage}`);
      return 2;
    }
    console.error(JSON.stringify({ error: { code: "UNEXPECTED", message: (e as Error).stack ?? String(e) } }, null, 2));
    return 1;
  }
}
