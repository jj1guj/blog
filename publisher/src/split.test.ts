import assert from "node:assert/strict";
import test from "node:test";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { createArticleMarkdown, extractArticleImages } from "./markdown.ts";
import { splitArticleStatus } from "./split.ts";

const articleUrl = "https://blog.example/posts/article/";

function prepare(html: string) {
  return {
    markdown: createArticleMarkdown("題名", html, articleUrl),
    images: extractArticleImages(html, articleUrl),
  };
}

function parse(value: string) {
  return fromMarkdown(value, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

test("長い本文をコードポイント上限内に分け、書記素を分断しない", () => {
  const family = "👨‍👩‍👧‍👦";
  const { markdown, images } = prepare(`<p>${"あ".repeat(9960)}${family}${"い".repeat(4000)}</p>`);
  const parts = splitArticleStatus(markdown, images, 10000, 0);

  assert.equal(parts.length, 2);
  assert.equal(parts.map((part) => part.status).join(""), markdown.status);
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
  assert.equal(parts.filter((part) => part.status.includes(family)).length, 1);
  assert.ok(parts.every((part) => !part.status.startsWith("\u200d") && !part.status.endsWith("\u200d")));
});

test("上限付近のリンク、装飾、数式、エスケープを途中で切らない", () => {
  const math = '<span class="katex"><annotation encoding="application/x-tex">x^2 + y^2</annotation></span>';
  const html = `<p>${"あ".repeat(9930)}<strong><a href="https://example.test/a(b)?x=1">詳しいリンク</a></strong> と ${math} &amp; 記号 * ${"後".repeat(120)}</p>`;
  const { markdown, images } = prepare(html);
  const parts = splitArticleStatus(markdown, images, 10000, 0);
  const link = "**[詳しいリンク](https://example.test/a\\(b\\)?x=1)**";

  assert.equal(parts.map((part) => part.status).join(""), markdown.status);
  assert.equal(parts.filter((part) => part.status.includes(link)).length, 1);
  assert.ok(parts[1].status.includes(link));
  assert.equal(parts.filter((part) => part.status.includes("$x^2 + y^2$")).length, 1);
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
  assert.ok(parts.every((part) => !part.status.endsWith("\\")));
});

test("単独で上限を超えるリンクや数式は切断せず明示的に拒否する", () => {
  const url = `https://example.test/${"x".repeat(10000)}`;
  const link = prepare(`<p><a href="${url}">長いリンク</a></p>`);
  assert.throws(
    () => splitArticleStatus(link.markdown, link.images, 10000, 0),
    /construct or link exceeds/,
  );
  const math = prepare(
    `<p><span class="katex"><annotation encoding="application/x-tex">${"x".repeat(10000)}</annotation></span></p>`,
  );
  assert.throws(
    () => splitArticleStatus(math.markdown, math.images, 10000, 0),
    /construct or link exceeds/,
  );
});

test("長いコードブロックは言語とフェンスを各投稿に付け、内容を失わない", () => {
  const code = "x".repeat(22000);
  const { markdown, images } = prepare(`<pre><code class="language-ts">${code}</code></pre>`);
  const parts = splitArticleStatus(markdown, images, 10000, 0);
  const blocks = parts.flatMap((part) => parse(part.status).children.filter((node) => node.type === "code"));

  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((block) => block.lang === "ts"));
  assert.equal(blocks.map((block) => block.value).join(""), code);
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
});

test("コードブロックを行境界で分割しても改行を失わない", () => {
  const code = `${"a".repeat(5000)}\n${"b".repeat(5000)}\n${"c".repeat(5000)}`;
  const { markdown, images } = prepare(`<pre><code>${code}</code></pre>`);
  const parts = splitArticleStatus(markdown, images, 10000, 0);
  const blocks = parts.flatMap((part) => parse(part.status).children.filter((node) => node.type === "code"));

  assert.ok(blocks.length > 1);
  assert.equal(blocks.map((block) => block.value).join(""), code);
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
});

test("分割後のコード行頭に現れるバッククォートもフェンスとして誤認しない", () => {
  const code = `${"a".repeat(9992)}\`\`\`\n${"b".repeat(200)}`;
  const { markdown, images } = prepare(`<pre><code>${code}</code></pre>`);
  const parts = splitArticleStatus(markdown, images, 10000, 0);
  const blocks = parts.flatMap((part) => parse(part.status).children.filter((node) => node.type === "code"));

  assert.ok(blocks.length > 1);
  assert.equal(blocks.map((block) => block.value).join(""), code);
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
});

test("長い表は見出しを繰り返し、行の途中で切らない", () => {
  const rows = Array.from({ length: 500 }, (_, index) =>
    `<tr><td>行${index}</td><td>${"値".repeat(30)}</td></tr>`,
  ).join("");
  const { markdown, images } = prepare(
    `<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
  const parts = splitArticleStatus(markdown, images, 10000, 0);
  const tables = parts.flatMap((part) => parse(part.status).children.filter((node) => node.type === "table"));

  assert.ok(tables.length >= 2);
  assert.equal(tables.reduce((count, table) => count + table.children.length - 1, 0), 500);
  for (const table of tables) {
    assert.equal(table.children[0].children[0].children[0].type, "text");
    const heading = table.children[0].children[0].children[0];
    assert.equal(heading.type === "text" ? heading.value : "", "項目");
  }
  assert.ok(parts.every((part) => Array.from(part.status).length <= 10000));
});

test("画像は出現順に上限以内へ分け、同じ URL は一度だけ添付する", () => {
  const html = Array.from({ length: 17 }, (_, index) =>
    `<p><img src="/${index}.png" alt="画像${index}"></p>`,
  ).join("") + '<p><img src="/0.png#center" alt="重複"></p>';
  const { markdown, images } = prepare(html);
  const parts = splitArticleStatus(markdown, images, 10000, 8);

  assert.deepEqual(parts.map((part) => part.images.length), [8, 8, 1]);
  assert.deepEqual(parts.flatMap((part) => part.images), images);
  assert.equal(parts.map((part) => part.status).join(""), markdown.status);
  for (const part of parts) {
    for (const image of part.images) assert.ok(part.status.includes(image.url));
  }
});

test("1つのリンク内に添付上限を超える画像がある場合は画像だけの返信を作る", () => {
  const html = `<a href="/destination">${Array.from({ length: 9 }, (_, index) =>
    `<img src="/${index}.png" alt="${index}">`,
  ).join("")}</a>`;
  const { markdown, images } = prepare(html);
  const parts = splitArticleStatus(markdown, images, 10000, 8);
  const linked = parts.filter((part) => part.status.includes("/destination"));
  const mediaOnly = parts.filter((part) => part.status === "");

  assert.equal(linked.length, 1);
  assert.equal(linked[0].images.length, 8);
  assert.deepEqual(mediaOnly.map((part) => part.images.length), [1]);
  assert.deepEqual(parts.flatMap((part) => part.images), images);
  assert.equal(parts.map((part) => part.status).join(""), markdown.status);
});
