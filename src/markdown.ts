import { randomUUID } from "node:crypto";
import { Marked, type Tokens } from "marked";

/** PR TIMES limits shown in the editor. */
export const TITLE_MAX = 100;
export const SUBTITLE_MAX = 100;
export const BODY_MAX = 8000;
export const IMAGES_MAX = 30;

export interface ParsedRelease {
  title: string | undefined;
  subtitle: string | undefined;
  /** Markdown body without frontmatter / leading H1 title. */
  markdown: string;
  frontmatter: Record<string, string>;
}

export interface BodyImage {
  file_name: string;
  file_name_s3: string;
  width?: number;
  height?: number;
}

export interface ConvertOptions {
  /** Markdown image src -> uploaded image. Images found here become image blocks. */
  images?: ReadonlyMap<string, BodyImage>;
}

export interface ConvertResult {
  html: string;
  /** Visible characters, as the editor's 文字数 counter counts them. */
  textLength: number;
  /** Uploaded images in body order, with captions (the save payload's `images`). */
  images: Array<{ file_name: string; file_name_s3: string; caption: string }>;
  warnings: string[];
}

/** Split simple `key: value` YAML frontmatter (a block list under a key becomes "a, b") and pick the title (frontmatter > first H1). */
export function parseRelease(source: string): ParsedRelease {
  let markdown = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const frontmatter: Record<string, string> = {};
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, "$2");
    let listKey: string | null = null;
    for (const line of fm[1]!.split("\n")) {
      const item = listKey ? line.match(/^\s+-\s+(.*)$/) : null;
      if (item && listKey) {
        const prev = frontmatter[listKey]!;
        frontmatter[listKey] = prev ? `${prev}, ${unquote(item[1]!)}` : unquote(item[1]!);
        continue;
      }
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) continue;
      frontmatter[m[1]!] = unquote(m[2]!);
      listKey = m[2]!.trim() === "" ? m[1]! : null;
    }
    markdown = markdown.slice(fm[0].length);
  }
  let title: string | undefined = frontmatter.title || undefined;
  if (!title) {
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*#*\s*(\n|$)/);
    if (h1) {
      title = h1[1]!.trim();
      markdown = markdown.slice(h1[0].length);
    }
  }
  return { title, subtitle: frontmatter.subtitle || undefined, markdown: markdown.replace(/^\n+/, ""), frontmatter };
}

/** Image srcs referenced by the Markdown, in order (deduplicated). */
export function imageRefs(markdown: string): string[] {
  const refs: string[] = [];
  const marked = new Marked({ gfm: true });
  marked.walkTokens(marked.lexer(markdown), (t) => {
    if (t.type === "image") refs.push((t as Tokens.Image).href);
  });
  return [...new Set(refs)];
}

/**
 * Convert Markdown to the HTML the PR TIMES editor (editor_version 3.0.0) stores.
 * - `#`/`##` -> 中見出し (h2), `###` -> 小見出し (h3), deeper -> bold paragraph
 * - uploaded images -> `<div class="pr-img">` blocks; the image title becomes the caption
 * - a YouTube URL alone on its line -> a YouTube embed
 * - blockquote -> 囲み (`pr-box`), a paragraph starting with ※ -> 注釈 (`pr-annotation`)
 * - code blocks and tables have no equivalent and are degraded with a warning
 */
export function markdownToPrtimesHtml(markdown: string, opts: ConvertOptions = {}): ConvertResult {
  const warnings: string[] = [];
  const images = opts.images ?? new Map<string, BodyImage>();
  const used: ConvertResult["images"] = [];
  const marked = new Marked({ gfm: true, breaks: true });
  const isUploaded = (t: Tokens.Generic) => t.type === "image" && images.has((t as Tokens.Image).href);

  const imageBlock = (t: Tokens.Image) => {
    const img = images.get(t.href)!;
    const caption = t.title ?? "";
    used.push({ file_name: img.file_name, file_name_s3: img.file_name_s3, caption });
    const size = img.width && img.height ? ` data-original-width="${img.width}" data-original-height="${img.height}"` : "";
    const src = `/api/file.php?t=origin&amp;f=${encodeURIComponent(img.file_name)}&amp;s3=${encodeURIComponent(img.file_name_s3)}`;
    return (
      `<div class="pr-img"><figure class="pr-img__item--large"><img src="${src}" data-filename="${esc(img.file_name)}" data-filenames3="${esc(img.file_name_s3)}"${size}>` +
      `<figcaption class="pr-img__item__caption">${esc(caption)}</figcaption></figure></div>`
    );
  };

  marked.use({
    renderer: {
      heading(this: any, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth <= 2) return `<h2>${inner}</h2>`;
        if (token.depth === 3) return `<h3>${inner}</h3>`;
        return `<p><strong>${inner}</strong></p>\n`;
      },
      paragraph(this: any, token: Tokens.Paragraph) {
        const lone = loneUrl(token);
        const yt = lone ? youtubeId(lone) : null;
        if (lone && yt) {
          return `<div class="pr-embed--youtube" data-url="https://www.youtube.com/watch?v=${yt}"><img src="/api/movieim.php?url=www.youtube.com/watch?v=${yt}"></div><p></p>\n`;
        }
        const annotation = /^[※＊*]/.test(token.text.trim()) && !token.text.trim().startsWith("**");
        const open = annotation ? `<p class="pr-annotation">` : "<p>";
        // The editor has no inline images: lift uploaded images out into their own blocks.
        if (!token.tokens.some(isUploaded)) return `${open}${this.parser.parseInline(token.tokens)}</p>\n`;
        let out = "";
        let run: Tokens.Generic[] = [];
        const flush = () => {
          const inner = this.parser.parseInline(run).replace(/^(\s|<br>)+|(\s|<br>)+$/g, "");
          if (inner) out += `${open}${inner}</p>\n`;
          run = [];
        };
        for (const t of token.tokens) {
          if (isUploaded(t)) {
            flush();
            out += imageBlock(t as Tokens.Image);
          } else run.push(t);
        }
        flush();
        return out;
      },
      image(token: Tokens.Image) {
        // Only reached for images that were not uploaded (URLs, or inside lists/tables).
        warnings.push(`Image not uploaded (only local files on their own line are): ${token.href}`);
        return `<a target="_blank" rel="nofollow ugc noopener" class="pr-link" href="${esc(token.href)}">${esc(token.text || token.href)}</a>`;
      },
      link(this: any, token: Tokens.Link) {
        const text = this.parser.parseInline(token.tokens);
        return `<a target="_blank" rel="nofollow ugc noopener" class="pr-link" data-link-id="${randomUUID()}" href="${esc(token.href)}">${text}</a>`;
      },
      strong(this: any, token: Tokens.Strong) {
        return `<strong>${this.parser.parseInline(token.tokens)}</strong>`;
      },
      em(this: any, token: Tokens.Em) {
        return `<em>${this.parser.parseInline(token.tokens)}</em>`;
      },
      del(this: any, token: Tokens.Del) {
        return this.parser.parseInline(token.tokens);
      },
      codespan(token: Tokens.Codespan) {
        return token.text;
      },
      br() {
        return "<br>";
      },
      list(this: any, token: Tokens.List) {
        const tag = token.ordered ? "ol" : "ul";
        const items = token.items
          .map((item) => {
            const inner = item.tokens
              .map((t) =>
                t.type === "text"
                  ? `<p>${this.parser.parseInline((t as Tokens.Text).tokens ?? [t])}</p>\n`
                  : this.parser.parse([t]),
              )
              .join("");
            return `<li>${inner}</li>\n`;
          })
          .join("");
        return `<${tag}>${items}</${tag}>\n`;
      },
      blockquote(this: any, token: Tokens.Blockquote) {
        return `<div class="pr-box">${this.parser.parse(token.tokens)}</div>\n`;
      },
      hr() {
        return "<hr>\n";
      },
      code(token: Tokens.Code) {
        warnings.push("Code blocks have no PR TIMES equivalent; converted to plain paragraphs.");
        return `<p>${esc(token.text).replace(/\n/g, "<br>")}</p>\n`;
      },
      table(this: any, token: Tokens.Table) {
        warnings.push("Tables are not converted to the editor's table block; rows became paragraphs. Recreate the table in the editor if needed.");
        const row = (cells: Tokens.TableCell[]) => `<p>${cells.map((c) => this.parser.parseInline(c.tokens)).join(" / ")}</p>\n`;
        return row(token.header) + token.rows.map(row).join("");
      },
      html(token: Tokens.HTML | Tokens.Tag) {
        if (/^\s*<!--[\s\S]*-->\s*$/.test(token.text)) return "";
        warnings.push("Raw HTML is not passed through; it was escaped.");
        return esc(token.text);
      },
      text(this: any, token: Tokens.Text | Tokens.Escape) {
        if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
        return esc(token.text);
      },
    },
  });

  const html = (marked.parse(markdown, { async: false }) as string).trim();
  const textLength = visibleTextLength(html);
  if (textLength > BODY_MAX) warnings.push(`Body is ${textLength} characters; PR TIMES allows ${BODY_MAX}.`);
  if (used.length > IMAGES_MAX) warnings.push(`The body has ${used.length} images; PR TIMES allows ${IMAGES_MAX}.`);
  return { html, textLength, images: used, warnings };
}

/** A paragraph that is only a URL (bare, or a link whose text is the URL). */
function loneUrl(token: Tokens.Paragraph): string | null {
  const parts = token.tokens.filter((t) => !(t.type === "text" && !t.raw.trim()));
  if (parts.length !== 1) return null;
  const t = parts[0]!;
  if (t.type === "link" && ((t as Tokens.Link).text === (t as Tokens.Link).href || t.raw === (t as Tokens.Link).href)) return (t as Tokens.Link).href;
  return null;
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/);
      if (m) return m[2]!;
    }
  } catch {
    // not a URL
  }
  return null;
}

/** Plain text of the stored HTML (for reading a release back). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<div class="pr-img">[\s\S]*?<figcaption[^>]*>([\s\S]*?)<\/figcaption>[\s\S]*?<\/div>/g, (_m, cap) => `[画像${cap ? `: ${cap}` : ""}]\n`)
      .replace(/<div class="pr-embed--youtube" data-url="([^"]+)"[\s\S]*?<\/div>/g, "$1\n")
      .replace(/<h2[^>]*>/g, "\n## ")
      .replace(/<h3[^>]*>/g, "\n### ")
      .replace(/<li[^>]*>/g, "- ")
      .replace(/<\/(p|h2|h3|li|div)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function visibleTextLength(html: string): number {
  return [...decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s/g, "")].length;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
