import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import * as api from "./api.ts";
import { CliError, PrtimesClient, envCredentials } from "./client.ts";
import { isLocalImageRef, readImage, resolveImagePath, sizeFromS3Name, type ImageFile } from "./images.ts";
import { browserLogin, passwordLogin } from "./login.ts";
import {
  SUBTITLE_MAX,
  TITLE_MAX,
  htmlToText,
  imageRefs,
  markdownToPrtimesHtml,
  parseRelease,
  type BodyImage,
} from "./markdown.ts";
import {
  describeSettings,
  hasSettings,
  missingForSubmit,
  normalizeMasters,
  parseSchedule,
  resolveSettings,
  scheduledAt,
  settingsFromFrontmatter,
  type Masters,
  type SettingsInput,
  type SettingsSummary,
} from "./settings.ts";
import { AUTH_COOKIE, REFRESH_COOKIE, SESSION_COOKIE, clearSession, loadSession, parseCookieHeader, saveSession, sessionPath } from "./session.ts";

type Options = NonNullable<ParseArgsConfig["options"]>;
type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

export interface Deps {
  client?: PrtimesClient;
  /** fetch used for logging in (tests). */
  fetchImpl?: typeof fetch;
  readStdin?: () => Promise<string>;
  /** Whether a password can be prompted for on the terminal. */
  isTTY?: boolean;
}

interface Command {
  usage: string;
  summary: string;
  options?: Options;
  /** minimum number of positional args */
  args?: number;
  run(ctx: { values: Values; positionals: string[]; client: PrtimesClient; deps: Deps }): Promise<unknown>;
}

const DEFAULT_MAX_CHARS = "20000";
const CONTENT_OPTIONS: Options = {
  title: { type: "string" },
  subtitle: { type: "string" },
  "main-image": { type: "string" },
  "dry-run": { type: "boolean" },
};

const SETTINGS_OPTIONS: Options = {
  purpose: { type: "string" },
  type: { type: "string" },
  category: { type: "string" },
  subcategory: { type: "string" },
  keywords: { type: "string" },
  url: { type: "string" },
  at: { type: "string" },
};

/** release_send_kbn: 1 = draft, 2 = 今すぐ配信 (never sent by this CLI), 3 = 予約配信. */
const SEND_KBN = { draft: 1, reservation: 3 } as const;
/** release_send_target_type 2 = automatic media selection. */
const AUTO_TARGET = 2;

const COMMANDS: Record<string, Command> = {
  // ---------------- auth ----------------
  "auth login": {
    usage: "auth login [--timeout <sec>] [--browser <path>]  |  auth login --email <address> [--password-stdin]",
    summary:
      "Log in and save the session cookies: in a browser window by hand, or with --email and a password (prompted, from stdin, or PRTIMES_PASSWORD)",
    options: {
      timeout: { type: "string", default: "300" },
      browser: { type: "string" },
      email: { type: "string" },
      "password-stdin": { type: "boolean" },
    },
    async run({ values, deps }) {
      const email = typeof values.email === "string" ? values.email.trim() : process.env.PRTIMES_EMAIL;
      if (email || values["password-stdin"]) {
        if (!email) throw new CliError("USAGE", "--password-stdin needs --email <address> (or PRTIMES_EMAIL).");
        const password = await readPassword(values["password-stdin"] === true, deps);
        return finishLogin(await passwordLogin({ email, password, fetchImpl: deps.fetchImpl }), deps.fetchImpl);
      }
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
      if (!(await loadSession()) && !envCredentials()) return { loggedIn: false, sessionPath: sessionPath() };
      try {
        const me = await api.currentUser(client);
        const session = await client.getSession();
        return {
          loggedIn: true,
          companyId: me.company_id,
          companyName: me.company_name,
          // PR TIMES stores the family name in first_name.
          user: `${me.first_name} ${me.last_name}`.trim(),
          plan: me.plan_name,
          canRefresh: Boolean(session?.cookies[REFRESH_COOKIE]) || envCredentials() !== null,
          savedAt: session?.savedAt,
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
    usage: `release list [--page <n>] [--limit <n>] [--search <phrase>] [--status ${api.DELIVERY_STATUSES.join("|")}]`,
    summary: "List your company's press releases (drafts, scheduled, delivered), newest first",
    options: {
      page: { type: "string", default: "1" },
      limit: { type: "string", default: "20" },
      search: { type: "string" },
      status: { type: "string" },
    },
    async run({ values, client }) {
      if (typeof values.status === "string" && !(api.DELIVERY_STATUSES as readonly string[]).includes(values.status)) {
        throw new CliError("USAGE", `--status must be one of: ${api.DELIVERY_STATUSES.join(", ")}`);
      }
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
        settings: releaseSettings(await loadMasters(client), r),
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
      // Resolve settings first so that a bad value does not leave an empty draft behind.
      const settings = hasSettings(input.settings) ? resolveSettings(await loadMasters(client), {}, input.settings, new Date()) : null;
      if (values["dry-run"]) return { ...dryRun(input), ...(settings ? { settings: settings.summary } : {}) };
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
      if (values["dry-run"]) {
        if (!hasSettings(input.settings)) return dryRun(input);
        const current = await api.getRelease(client, id);
        return { ...dryRun(input), settings: resolveSettings(await loadMasters(client), current, input.settings, new Date()).summary };
      }
      return { updated: true, ...(await uploadAndSave(client, id, input)) };
    },
  },
  "draft options": {
    usage: "draft options",
    summary: "Choices for draft settings: purposes, release types and business categories (ids and names)",
    async run({ client }) {
      return loadMasters(client);
    },
  },
  "draft settings": {
    usage:
      'draft settings <release_id|url> [file.md] [--purpose <id|name>] [--type <id|name>] [--category <id|name>] [--subcategory <id|name|none>] [--keywords "a,b"] [--url <url>] [--at "YYYY-MM-DD HH:MM"] [--dry-run]',
    summary: "Save a draft's 追加情報 (purpose, type, business categories, keywords, related URL) and scheduled time; it stays a draft",
    options: { ...SETTINGS_OPTIONS, "dry-run": { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      const fromFile = positionals[1] ? settingsFromFrontmatter(parseRelease(await readSource(positionals[1])).frontmatter) : {};
      const input: SettingsInput = { ...fromFile, ...settingsFromValues(values) };
      if (!hasSettings(input)) throw new CliError("USAGE", "Nothing to set: pass options or a Markdown file whose frontmatter has settings.");
      const current = await api.getRelease(client, id);
      assertDraft(current, id);
      const { fields, summary } = resolveSettings(await loadMasters(client), current, input, new Date());
      if (values["dry-run"]) return { dryRun: true, releaseId: id, settings: summary };
      await api.saveRelease(client, { releaseId: id, companyId: current.company_id, pressRelease: api.buildSavePayload(current, fields) });
      return { releaseId: id, settings: summary, editUrl: api.editUrl(id), previewUrl: api.previewUrl(current.company_id, id) };
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

  "draft submit": {
    usage: 'draft submit <release_id|url> [--at "YYYY-MM-DD HH:MM"] [--yes]',
    summary: "Submit a draft as a scheduled delivery (予約配信; it goes to PR TIMES review). Without --yes, only shows what would be sent",
    options: { at: { type: "string" }, yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      const current = await api.getRelease(client, id);
      assertDraft(current, id);
      const now = new Date();
      const schedule = typeof values.at === "string" ? parseSchedule(values.at, now) : null;
      const target = schedule ? { ...current, release_date: schedule.release_date, release_time_kbn_2: schedule.release_time_kbn_2 } : current;
      const missing = missingForSubmit(target, now);
      if (missing.length) {
        throw new CliError("INCOMPLETE", `Release ${id} is missing: ${missing.join(", ")}. Set them with \`draft settings\` (or --at) first.`, { detail: { missing } });
      }
      const at = scheduledAt(target);
      if (!values.yes) {
        throw new CliError(
          "CONFIRMATION_REQUIRED",
          "Review the submission, then pass --yes to submit it as a scheduled delivery (予約配信). It goes to PR TIMES review.",
          {
            detail: {
              releaseId: id,
              title: target.title,
              scheduledAt: at,
              settings: describeSettings(await loadMasters(client), target),
              distribution: "automatic",
              previewUrl: api.previewUrl(current.company_id, id),
            },
          },
        );
      }
      // Automatic media selection; drop any manual media lists so the request is consistent.
      const overrides: Record<string, unknown> = {
        release_send_target_type: AUTO_TARGET,
        company_release_media_join_master_id: null,
        company_m_my_release_media_master_id: null,
        release_send_kbn: SEND_KBN.reservation,
      };
      if (schedule) Object.assign(overrides, { release_date: schedule.release_date, release_time_kbn_2: schedule.release_time_kbn_2 });
      await api.updateRelease(client, { releaseId: id, companyId: current.company_id, pressRelease: api.buildSavePayload(current, overrides, api.SUBMIT_FIELDS) });
      const after = await api.getRelease(client, id);
      const status = after?.delivery_status;
      return {
        submitted: true,
        releaseId: id,
        scheduledAt: at,
        status,
        editUrl: api.editUrl(id),
        previewUrl: api.previewUrl(current.company_id, id),
        warnings: status === "scheduled" ? [] : [`Status is "${status}", not "scheduled". Check with release get; do not submit again.`],
      };
    },
  },
  "draft unsubmit": {
    usage: "draft unsubmit <release_id|url> --yes",
    summary: "Take a scheduled release (予約配信) back to draft",
    options: { yes: { type: "boolean" } },
    args: 1,
    async run({ values, positionals, client }) {
      const id = releaseId(positionals[0]!);
      if (!values.yes) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to take the scheduled release back to draft.");
      const current = await api.getRelease(client, id);
      if (!current || typeof current !== "object") throw new CliError("NOT_FOUND", `Release ${id} not found.`);
      if (current.delivery_status !== "scheduled") {
        throw new CliError("NOT_SCHEDULED", `Release ${id} is "${current.delivery_status}", not a scheduled delivery.`);
      }
      await api.updateRelease(client, {
        releaseId: id,
        companyId: current.company_id,
        pressRelease: api.buildSavePayload(current, { release_send_kbn: SEND_KBN.draft }, api.SUBMIT_FIELDS),
      });
      const status = (await api.getRelease(client, id))?.delivery_status;
      return {
        unsubmitted: true,
        releaseId: id,
        status,
        warnings: status === "draft" ? [] : [`Status is "${status}", not "draft". Check with release get.`],
      };
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
  /** Settings found in the frontmatter. */
  settings: SettingsInput;
  warnings: string[];
}

async function readInput(file: string, values: Values): Promise<Input> {
  const source = await readSource(file);
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
  return { title, subtitle, markdown: parsed.markdown, baseDir, images, mainImage, settings: settingsFromFrontmatter(parsed.frontmatter), warnings };
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

  const settings = hasSettings(input.settings) ? resolveSettings(await loadMasters(client), current, input.settings, new Date()) : null;
  const payload = api.buildSavePayload(current, {
    ...settings?.fields,
    ...api.contentFields({
      title: input.title,
      subtitle: input.subtitle,
      text: converted.html,
      images: converted.images,
      mainImage: main ? { file_name: main.file_name, file_name_s3: main.file_name_s3 } : null,
    }),
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
    ...(settings ? { settings: settings.summary } : {}),
    warnings: [...input.warnings, ...converted.warnings],
  };
}

/** Setting names for a release; the saved date counts as a schedule only once the release is scheduled. */
function releaseSettings(m: Masters, r: any): SettingsSummary {
  const s = describeSettings(m, r);
  return { ...s, scheduledAt: r.delivery_status === "scheduled" ? s.scheduledAt : null };
}

async function loadMasters(client: PrtimesClient): Promise<Masters> {
  const editor = await api.editorInfo(client);
  return normalizeMasters(editor, await api.purposes(client));
}

function settingsFromValues(values: Values): SettingsInput {
  const out: SettingsInput = {};
  for (const k of Object.keys(SETTINGS_OPTIONS) as Array<keyof SettingsInput>) {
    if (typeof values[k] === "string") out[k] = values[k] as string;
  }
  return out;
}

async function readSource(file: string): Promise<string> {
  if (file === "-") return readStdin();
  return readFile(file, "utf8").catch(() => {
    throw new CliError("INVALID_INPUT", `Cannot read ${file}.`);
  });
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

async function finishLogin(cookies: Record<string, string>, fetchImpl?: typeof fetch) {
  const client = new PrtimesClient({ session: { cookies, savedAt: "probe" }, fetchImpl });
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

/** The password from the first line of stdin, PRTIMES_PASSWORD, or a hidden prompt — never from an argument. */
async function readPassword(fromStdin: boolean, deps: Deps): Promise<string> {
  let password: string | undefined;
  if (fromStdin) password = (await (deps.readStdin ?? readStdin)()).split(/\r?\n/)[0];
  else if (process.env.PRTIMES_PASSWORD) password = process.env.PRTIMES_PASSWORD;
  else if (deps.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)) password = await promptHidden("PR TIMES password: ");
  else throw new CliError("USAGE", "No password: run in a terminal to be prompted, or pass it with --password-stdin or PRTIMES_PASSWORD.");
  if (!password) throw new CliError("USAGE", "The password is empty.");
  return password;
}

/** Read a line from the terminal, echoing * instead of the characters. */
function promptHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(label);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const k = passwordKey(buf, ch);
        if (k.done === "enter") return done();
        if (k.done === "cancel") return done(new CliError("LOGIN_ABORTED", "Cancelled."));
        buf = k.buf;
        process.stderr.write(k.echo);
      }
    };
    stdin.on("data", onData);
  });
}

/** One key of the password prompt: the new buffer, what to echo (a * per character), or the end of input. */
export function passwordKey(buf: string, ch: string): { buf: string; echo: string; done?: "enter" | "cancel" } {
  if (ch === "\r" || ch === "\n" || ch === "\u0004") return { buf, echo: "", done: "enter" };
  if (ch === "\u0003") return { buf, echo: "", done: "cancel" };
  if (ch === "\u007f" || ch === "\b") return buf ? { buf: [...buf].slice(0, -1).join(""), echo: "\b \b" } : { buf, echo: "" };
  return { buf: buf + ch, echo: "*" };
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
    "Env: PRTIMES_COOKIE (Cookie header, overrides saved session), PRTIMES_EMAIL + PRTIMES_PASSWORD (log in automatically when there is no valid session), PRTIMES_CLI_HOME, PRTIMES_CLI_INTERVAL_MS, PRTIMES_CLI_DEBUG, PRTIMES_CLI_BROWSER",
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
    const result = await cmd.run({ values: values as Values, positionals, client, deps });
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
