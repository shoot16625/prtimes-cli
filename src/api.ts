import { CliError, ORIGIN, type PrtimesClient } from "./client.ts";

const EDITOR = "/api/press_release_editor.php";

export interface CompanyUser {
  company_id: number;
  company_name: string;
  company_user_id: number;
  first_name: string;
  last_name: string;
  plan_name: string | null;
  is_releasable: boolean;
}

export interface UploadedImage {
  file_name: string;
  file_name_s3: string;
  isCMYK?: boolean;
}

export const DELIVERY_STATUSES = ["draft", "reserved", "released", "withdrawn_by_review"] as const;

export function editUrl(releaseId: number): string {
  return `${ORIGIN}/my_c3/action.php?run=mypage&page=pressreleaseedit&release_id=${releaseId}`;
}

/** Owner preview of a release (works for drafts while logged in). */
export function previewUrl(companyId: number, releaseId: number): string {
  return `${ORIGIN}/main/action.php?run=html&page=releasedetail&company_id=${companyId}&release_id=${releaseId}&owner=1`;
}

/** Public URL a release gets once delivered. */
export function publicUrl(companyId: number, releaseId: number): string {
  return `${ORIGIN}/main/html/rd/p/${String(releaseId).padStart(9, "0")}.${String(companyId).padStart(6, "0")}.html`;
}

export function currentUser(client: PrtimesClient): Promise<CompanyUser> {
  return client.request<CompanyUser>("/api/press_kit_edit.php/company_user/me");
}

export async function listReleases(
  client: PrtimesClient,
  opts: { page: number; limit: number; search?: string },
): Promise<{ items: any[]; pager: any }> {
  const data = await client.request<any>("/api/press_release_list.php/list", {
    query: {
      page: opts.page,
      limit: opts.limit,
      search_phrase: opts.search ?? "",
      published_flag: true,
      draft_flag: true,
      reserved_flag: true,
      publication_stopped_flag: true,
    },
  });
  return { items: data?.press_release_list ?? [], pager: data?.pager ?? null };
}

export function getRelease(client: PrtimesClient, releaseId: number): Promise<any> {
  return client.request<any>(`${EDITOR}/press_release/${releaseId}`);
}

/** Editor metadata: `edit_started_at` (needed to save) plus release types, categories and prefectures. */
export function editorInfo(client: PrtimesClient): Promise<any> {
  return client.request<any>(`${EDITOR}/press_release/editor`);
}

/** The CSRF token the editor page embeds as `<input id="csrf_token">`. */
export async function csrfToken(client: PrtimesClient, releaseId: number): Promise<string> {
  const html = await client.request<string>("/my_c3/action.php", {
    query: { run: "mypage", page: "pressreleaseedit", release_id: releaseId },
    text: true,
  });
  const m = String(html).match(/id="csrf_token"[^>]*value="([^"]+)"/) ?? String(html).match(/value="([^"]+)"[^>]*id="csrf_token"/);
  if (!m) throw new CliError("API_ERROR", `Could not find the editor's CSRF token for release ${releaseId}. Is it your release?`);
  return m[1]!;
}

/** Create an empty draft, as the admin screen's 「プレスリリース新規作成」 does. Returns its release_id. */
export async function createRelease(client: PrtimesClient): Promise<number> {
  const res = await client.requestRaw(`${EDITOR}/press_release/new`, { method: "POST", urlencoded: {}, manualRedirect: true, text: true });
  const location = res.headers.get("location") ?? "";
  const id = Number(location.match(/release_id=(\d+)/)?.[1]);
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError("API_ERROR", `Creating a draft did not return a release id (HTTP ${res.status}, Location: ${location || "none"}).`);
  }
  return id;
}

export async function uploadImage(
  client: PrtimesClient,
  releaseId: number,
  file: { bytes: Uint8Array<ArrayBuffer>; name: string; mime: string },
): Promise<UploadedImage> {
  const form = new FormData();
  form.append("image", new Blob([file.bytes], { type: file.mime }), file.name);
  const data = await client.request<UploadedImage>(`${EDITOR}/press_release/${releaseId}/image`, { method: "POST", form });
  if (!data?.file_name || !data?.file_name_s3) throw new CliError("API_ERROR", `Image upload of ${file.name} returned no file name.`, { detail: data });
  return data;
}

/** Fields the editor sends on save, in its order. Values not given are taken from the current release. */
const SAVE_FIELDS = [
  "editor_version",
  "title",
  "subtitle",
  "head",
  "text",
  "footer",
  "image_file_name_main",
  "image_file_name_main_s3",
  "images",
  "release_file_name",
  "reference_file_name",
  "media_release_file_name",
  "media_reference_file_name",
  "locations",
  "keywords",
  "release_send_target_type",
  "company_release_media_join_master_id",
  "company_m_my_release_media_master_id",
  "release_additional_headline_flg",
  "release_additional_fax_flg",
  "release_fax_file_name",
  "mail_title_prefix_company_name_flg",
  "mail_title_replacing_flg",
  "mail_title",
  "mail_body_head_flg",
  "mail_body_head_text",
  "media_user_sendmail_flg",
  "socialmedia_user_sendmail_flg",
  "other_site_send_flg",
  "release_media_user_only_flg",
  "release_media_list_only_flg",
  "is_file_download_unavailable",
  "twitter_send_flg",
  "facebook_send_flg",
] as const;

export interface ReleaseContent {
  title: string;
  subtitle: string;
  text: string;
  images: Array<{ file_name: string; file_name_s3: string; caption: string }>;
  mainImage: UploadedImage | null;
}

/** The editor's save payload: the current release with title, subtitle, body and images replaced. */
export function buildSavePayload(current: any, content: ReleaseContent): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...current,
    editor_version: current?.editor_version || "3.0.0",
    title: content.title,
    subtitle: content.subtitle,
    text: content.text,
    images: content.images,
    image_file_name_main: content.mainImage?.file_name ?? null,
    image_file_name_main_s3: content.mainImage?.file_name_s3 ?? null,
  };
  return Object.fromEntries(SAVE_FIELDS.map((k) => [k, merged[k] ?? defaultValue(k)]));
}

function defaultValue(key: (typeof SAVE_FIELDS)[number]): unknown {
  if (key === "images" || key === "locations" || key === "keywords") return [];
  if (key.endsWith("_flg") || key === "is_file_download_unavailable") return false;
  if (key.endsWith("_id") || key.startsWith("image_file_name_main")) return null;
  if (key === "release_send_target_type") return 1;
  return "";
}

/** Save the draft the way the editor's 保存 button does (PUT .../auto_save). */
export async function saveRelease(
  client: PrtimesClient,
  opts: { releaseId: number; companyId: number; pressRelease: Record<string, unknown> },
): Promise<void> {
  const csrf = await csrfToken(client, opts.releaseId);
  const editor = await editorInfo(client);
  const editStartedAt = Number(editor?.edit_started_at);
  if (!Number.isInteger(editStartedAt)) throw new CliError("API_ERROR", "The editor did not return edit_started_at.");
  await client.request(`${EDITOR}/press_release/${opts.releaseId}/auto_save`, {
    method: "PUT",
    json: {
      press_release: opts.pressRelease,
      csrf_token: csrf,
      edit_started_at: editStartedAt,
      company_id: opts.companyId,
      is_force_mode: false,
    },
  });
}

export async function deleteRelease(client: PrtimesClient, releaseId: number): Promise<void> {
  await client.request(`${EDITOR}/press_release/${releaseId}`, { method: "DELETE" });
}

export interface Stats {
  recentMonth: any;
  topPageViews: any;
  topSocial: any;
}

export async function dashboardStats(client: PrtimesClient): Promise<Stats> {
  const recentMonth = await client.request<any>("/api/dashboard.php/recent_month_analytics");
  const topPageViews = await client.request<any>("/api/dashboard.php/top_three_page_view_releases");
  const topSocial = await client.request<any>("/api/dashboard.php/top_three_social_releases");
  return { recentMonth, topPageViews, topSocial };
}
