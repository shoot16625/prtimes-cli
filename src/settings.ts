import { CliError } from "./client.ts";
import { htmlToText } from "./markdown.ts";

/** Release settings (追加情報設定 and the scheduled time): master data, name → ID resolution and checks. */

export interface Named<T> {
  id: T;
  name: string;
}

export interface Masters {
  purposes: { category: string; items: Named<number>[] }[];
  releaseTypes: Named<string>[];
  /** Selectable business categories are the `lv2` entries; their ids are unique across groups. */
  businessCategories: { group: string; items: Named<number>[] }[];
}

/** `editor` is GET .../press_release/editor data, `purposes` is GET .../purposes data. */
export function normalizeMasters(editor: any, purposes: any): Masters {
  return {
    purposes: (purposes ?? []).map((c: any) => ({
      category: String(c.category_name),
      items: (c.purpose_list ?? []).map((p: any) => ({ id: Number(p.purpose_id), name: String(p.purpose_name) })),
    })),
    releaseTypes: (editor?.release_types ?? []).map((t: any) => ({ id: String(t.release_type_id), name: String(t.release_type_name) })),
    businessCategories: (editor?.business_categories ?? []).map((c: any) => ({
      group: String(c.busi_cate_name),
      items: (c.lv2 ?? []).map((s: any) => ({ id: Number(s.id), name: String(s.name) })),
    })),
  };
}

/** Raw values as given on the command line or in frontmatter. */
export interface SettingsInput {
  purpose?: string;
  type?: string;
  category?: string;
  subcategory?: string;
  keywords?: string;
  url?: string;
  at?: string;
}

const KEYS = ["purpose", "type", "category", "subcategory", "keywords", "url", "at"] as const;

export function settingsFromFrontmatter(fm: Record<string, string>): SettingsInput {
  const out: SettingsInput = {};
  for (const k of KEYS) {
    const raw = k === "at" ? (fm.scheduledAt ?? fm.scheduled_at) : fm[k];
    // An empty key (e.g. `keywords:` with nothing under it) means "not set", never "clear".
    if (raw === undefined || raw.trim() === "") continue;
    out[k] = k === "keywords" ? raw.replace(/^\[(.*)\]$/s, "$1") : raw;
  }
  return out;
}

export function hasSettings(s: SettingsInput): boolean {
  return KEYS.some((k) => s[k] !== undefined);
}

export interface SettingsSummary {
  purpose: Named<number> | null;
  type: Named<string> | null;
  category: Named<number> | null;
  subcategory: Named<number> | null;
  keywords: string[];
  url: string | null;
  /** "YYYY-MM-DD HH:MM", Japan time. */
  scheduledAt: string | null;
}

export const KEYWORD_MAX = 60;
export const URL_MAX = 240;

export function resolveSettings(
  m: Masters,
  current: any,
  input: SettingsInput,
  now: Date,
): { fields: Record<string, unknown>; summary: SettingsSummary } {
  const fields: Record<string, unknown> = {};
  if (input.purpose !== undefined) fields.purpose_id = resolvePurpose(m, input.purpose).id;
  if (input.type !== undefined) fields.release_type_id = resolveType(m, input.type).id;
  if (input.category !== undefined) fields.busi_cate_id_main = resolveCategory(m, input.category, "category").id;
  if (input.subcategory !== undefined) {
    fields.busi_cate_id_sub = input.subcategory.trim().toLowerCase() === "none" ? null : resolveCategory(m, input.subcategory, "subcategory").id;
  }
  const main = "busi_cate_id_main" in fields ? fields.busi_cate_id_main : current?.busi_cate_id_main;
  const sub = "busi_cate_id_sub" in fields ? fields.busi_cate_id_sub : current?.busi_cate_id_sub;
  if (main != null && sub != null && Number(main) === Number(sub)) {
    throw new CliError("INVALID_OPTION", `The second business category (${sub}) must differ from the main one; pass --subcategory with another category or "none".`);
  }
  if (input.keywords !== undefined) fields.keywords = parseKeywords(input.keywords);
  if (input.url !== undefined) fields.reference_url = checkUrl(input.url);
  if (input.at !== undefined) {
    const s = parseSchedule(input.at, now);
    fields.release_date = s.release_date;
    fields.release_time_kbn_2 = s.release_time_kbn_2;
  }
  return { fields, summary: describeSettings(m, { ...current, ...fields }) };
}

function resolvePurpose(m: Masters, raw: string): Named<number> {
  const all = m.purposes.flatMap((c) => c.items);
  return pick(raw, "purpose", all, all.map((p) => p.name), (v) => (/^\d+$/.test(v) ? all.filter((p) => p.id === Number(v)) : all.filter((p) => p.name === v)));
}

function resolveType(m: Masters, raw: string): Named<string> {
  const all = m.releaseTypes;
  return pick(raw, "type", all, all.map((t) => t.name), (v) => {
    if (!/^\d+$/.test(v)) return all.filter((t) => t.name === v);
    return all.filter((t) => t.id === v.padStart(t.id.length, "0"));
  });
}

function resolveCategory(m: Masters, raw: string, label: string): Named<number> {
  const all = m.businessCategories.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
  const full = (c: { group: string; name: string }) => `${c.group} > ${c.name}`;
  const found = pick(raw, label, all, all.map(full), (v) => {
    if (/^\d+$/.test(v)) return all.filter((c) => c.id === Number(v));
    if (v.includes(">")) {
      const [g, n] = v.split(">").map((x) => x.trim());
      return all.filter((c) => c.group === g && c.name === n);
    }
    return all.filter((c) => c.name === v);
  }, full);
  return { id: found.id, name: found.name };
}

function pick<T extends Named<unknown>>(
  raw: string,
  label: string,
  all: T[],
  names: string[],
  match: (v: string) => T[],
  show: (x: T) => string = (x) => x.name,
): T {
  const v = raw.trim();
  const hits = match(v);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new CliError("INVALID_OPTION", `${label} "${v}" matches more than one entry; use "group > name" or the id.`, { detail: { candidates: hits.map(show) } });
  }
  throw new CliError("INVALID_OPTION", `Unknown ${label} "${v}". Run \`prtimes-cli draft options\` for the choices.`, { detail: { candidates: names } });
}

function parseKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const k of raw.split(/[,、]/).map((x) => x.trim().replace(/^(['"])(.*)\1$/, "$2").trim())) {
    if (k && !out.includes(k)) out.push(k);
  }
  for (const k of out) {
    if ([...k].length > KEYWORD_MAX) throw new CliError("INVALID_INPUT", `Keyword "${k}" is ${[...k].length} characters; PR TIMES allows ${KEYWORD_MAX}.`);
  }
  return out;
}

function checkUrl(raw: string): string {
  const v = raw.trim();
  if (v === "") return "";
  if (!/^https?:\/\/\S+$/.test(v)) throw new CliError("INVALID_INPUT", `Related URL must be an http(s) URL: ${v}`);
  if (v.length > URL_MAX) throw new CliError("INVALID_INPUT", `Related URL is ${v.length} characters; PR TIMES allows ${URL_MAX}.`);
  return v;
}

const JST_OFFSET_H = 9;

/** "YYYY-MM-DD HH:MM" (Japan time, 10-minute steps, in the future) → the editor's release_date / release_time_kbn_2. */
export function parseSchedule(s: string, now: Date): { release_date: string; release_time_kbn_2: string; at: string } {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) throw new CliError("USAGE", `Scheduled time must look like "2026-11-20 10:00" (Japan time): ${s}`);
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const utc = new Date(Date.UTC(y, mo - 1, d, h - JST_OFFSET_H, mi));
  const back = new Date(utc.getTime() + JST_OFFSET_H * 3600_000);
  if (h > 23 || mi > 59 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    throw new CliError("INVALID_INPUT", `Not a valid date and time: ${s}`);
  }
  if (mi % 10 !== 0) throw new CliError("INVALID_INPUT", `PR TIMES schedules in 10-minute steps; ${s} is not on one.`);
  if (utc.getTime() <= now.getTime()) throw new CliError("INVALID_INPUT", `Scheduled time ${s} (Japan time) is not in the future.`);
  const hh = String(h).padStart(2, "0");
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return { release_date: date, release_time_kbn_2: `${hh}${m[5]}`, at: `${date} ${hh}:${m[5]}` };
}

/** The saved release_date + release_time_kbn_2 as "YYYY-MM-DD HH:MM", or null. */
export function scheduledAt(release: any): string | null {
  const date = release?.release_date;
  const time = release?.release_time_kbn_2;
  if (!date || time === null || time === undefined || time === "") return null;
  const t = String(time).padStart(4, "0");
  return `${date} ${t.slice(0, 2)}:${t.slice(2)}`;
}

/** Names for the setting IDs a release holds. */
export function describeSettings(m: Masters, release: any): SettingsSummary {
  const purposes = m.purposes.flatMap((c) => c.items);
  const cats = m.businessCategories.flatMap((g) => g.items);
  const named = <T>(list: Named<T>[], id: T | null | undefined, eq: (a: T, b: T) => boolean): Named<T> | null => {
    if (id === null || id === undefined || (id as unknown) === "" || (id as unknown) === 0) return null;
    return list.find((x) => eq(x.id, id)) ?? { id, name: "(unknown)" };
  };
  const num = (a: number, b: number) => Number(a) === Number(b);
  return {
    purpose: named(purposes, release?.purpose_id, num),
    type: named(m.releaseTypes, release?.release_type_id, (a, b) => a === String(b)),
    category: named(cats, release?.busi_cate_id_main, num),
    subcategory: named(cats, release?.busi_cate_id_sub, num),
    keywords: release?.keywords ?? [],
    url: release?.reference_url || null,
    scheduledAt: scheduledAt(release),
  };
}

/** What a draft still lacks before it can be submitted as a scheduled delivery. */
export function missingForSubmit(release: any, now: Date): string[] {
  const missing: string[] = [];
  if (!String(release?.title ?? "").trim()) missing.push("title");
  if (!htmlToText(String(release?.text ?? "")).trim()) missing.push("body");
  if (!release?.image_file_name_main_s3) missing.push("main image");
  if (!(Number(release?.purpose_id) > 0)) missing.push("purpose");
  if (!release?.release_type_id) missing.push("type");
  if (!(Number(release?.busi_cate_id_main) > 0)) missing.push("business category");
  const at = scheduledAt(release);
  let future = false;
  if (at) {
    try {
      parseSchedule(at, now);
      future = true;
    } catch {
      future = false;
    }
  }
  if (!future) missing.push("scheduled time (future)");
  return missing;
}
