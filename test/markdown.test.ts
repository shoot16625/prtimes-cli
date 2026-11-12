import assert from "node:assert/strict";
import { test } from "bun:test";
import { htmlToText, imageRefs, markdownToPrtimesHtml, parseRelease, visibleTextLength, youtubeId } from "../src/markdown.ts";

const strip = (html: string) => html.replace(/ data-link-id="[^"]+"/g, "");

test("parseRelease reads frontmatter title/subtitle, else the first H1", () => {
  const fm = parseRelease("---\ntitle: \"新サービス開始\"\nsubtitle: 副題\nmainImage: a.png\n---\n\n本文");
  assert.equal(fm.title, "新サービス開始");
  assert.equal(fm.subtitle, "副題");
  assert.equal(fm.frontmatter.mainImage, "a.png");
  assert.equal(fm.markdown, "本文");

  const h1 = parseRelease("# 見出しタイトル\n\n本文");
  assert.equal(h1.title, "見出しタイトル");
  assert.equal(h1.markdown, "本文");
});

test("headings map to 中見出し/小見出し and deeper levels to bold paragraphs", () => {
  const { html } = markdownToPrtimesHtml("## A\n\n### B\n\n#### C");
  assert.equal(html, "<h2>A</h2><h3>B</h3><p><strong>C</strong></p>");
});

test("links get the editor's pr-link attributes", () => {
  const { html } = markdownToPrtimesHtml("[site](https://example.com) and **bold** *em*");
  assert.equal(
    strip(html),
    '<p><a target="_blank" rel="nofollow ugc noopener" class="pr-link" href="https://example.com">site</a> and <strong>bold</strong> <em>em</em></p>',
  );
});

test("lists wrap items in paragraphs; quotes become 囲み; ※ lines become 注釈", () => {
  const { html } = markdownToPrtimesHtml("- a\n- b\n\n1. x\n\n> boxed\n\n※ note");
  assert.equal(
    html,
    '<ul><li><p>a</p>\n</li>\n<li><p>b</p>\n</li>\n</ul>\n<ol><li><p>x</p>\n</li>\n</ol>\n<div class="pr-box"><p>boxed</p>\n</div>\n<p class="pr-annotation">※ note</p>',
  );
});

test("uploaded images become pr-img blocks with captions and sizes", () => {
  const images = new Map([["a.png", { file_name: "d1-2-x-0.png", file_name_s3: "1-2-y-1200x630.png", width: 1200, height: 630 }]]);
  const r = markdownToPrtimesHtml('前\n\n![alt](a.png "説明")\n\n後', { images });
  assert.equal(
    r.html,
    '<p>前</p>\n<div class="pr-img"><figure class="pr-img__item--large"><img src="/api/file.php?t=origin&amp;f=d1-2-x-0.png&amp;s3=1-2-y-1200x630.png" data-filename="d1-2-x-0.png" data-filenames3="1-2-y-1200x630.png" data-original-width="1200" data-original-height="630"><figcaption class="pr-img__item__caption">説明</figcaption></figure></div><p>後</p>',
  );
  assert.deepEqual(r.images, [{ file_name: "d1-2-x-0.png", file_name_s3: "1-2-y-1200x630.png", caption: "説明" }]);
});

test("images that were not uploaded become links with a warning", () => {
  const r = markdownToPrtimesHtml("![x](https://example.com/a.png)");
  assert.match(r.html, /<a [^>]*href="https:\/\/example.com\/a.png">x<\/a>/);
  assert.equal(r.warnings.length, 1);
});

test("a YouTube URL alone on its line becomes an embed", () => {
  const { html } = markdownToPrtimesHtml("https://youtu.be/LNyizm02QTw");
  assert.equal(
    html,
    '<div class="pr-embed--youtube" data-url="https://www.youtube.com/watch?v=LNyizm02QTw"><img src="/api/movieim.php?url=www.youtube.com/watch?v=LNyizm02QTw"></div><p></p>',
  );
  assert.equal(youtubeId("https://www.youtube.com/shorts/abc_123"), "abc_123");
  assert.equal(youtubeId("https://example.com/watch?v=x"), null);
});

test("code blocks, tables and raw HTML are degraded with warnings", () => {
  const r = markdownToPrtimesHtml("```\na < b\n```\n\n| h |\n|---|\n| v |\n\n<div>x</div>");
  assert.equal(r.html, "<p>a &lt; b</p>\n<p>h</p>\n<p>v</p>\n&lt;div&gt;x&lt;/div&gt;");
  assert.equal(r.warnings.length, 3);
});

test("imageRefs lists image sources once, in order", () => {
  assert.deepEqual(imageRefs("![](a.png)\n\n- ![](b.png)\n\n![](a.png)"), ["a.png", "b.png"]);
});

test("htmlToText and visibleTextLength read stored HTML", () => {
  const html = '<h2>見出し</h2><p>本文&amp;<br>改行</p><ul><li><p>項目</p></li></ul>';
  assert.equal(htmlToText(html), "## 見出し\n本文&\n改行\n- 項目");
  assert.equal(visibleTextLength(html), 10);
});
