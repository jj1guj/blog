import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStatusText,
  loadPostMap,
  parseRss,
  publishNewItems,
  readConfig,
  remoteViewDirectory,
  syncRemoteViewPages,
  type FeedItem,
  type PublisherOptions,
} from "./index.ts";

const blogUrl = "https://blog.example";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function feed(items: string[]): string {
  return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:publisher="urn:blog-publisher"><channel><publisher:full-content>1</publisher:full-content>${items.join("")}</channel></rss>`;
}

function item(
  slug: string,
  title = `記事 ${slug}`,
  html = `<p>本文 ${slug}</p><p>二段落目</p>`,
  publishedAt = "Sat, 31 Oct 2026 00:00:00 +0000",
): string {
  return `<item><title>${escapeXml(title)}</title><link>${blogUrl}/posts/${slug}/</link><pubDate>${publishedAt}</pubDate><description>概要</description><content:encoded>${escapeXml(html)}</content:encoded></item>`;
}

function article(slug: string, title: string, html: string): FeedItem {
  return {
    path: `/posts/${slug}/`,
    title,
    contentHtml: html,
    url: `${blogUrl}/posts/${slug}/`,
  };
}

function options(
  feedPath: string,
  mapPath: string,
  fetchImpl: typeof fetch,
  publishExistingOnFirstRun = false,
): PublisherOptions {
  return {
    feedPath,
    mapPath,
    blogUrl,
    holloApiUrl: "http://hollo:3000",
    accessToken: "test-token-never-log",
    publishExistingOnFirstRun,
    fetchImpl,
  };
}

function mockHollo(characterLimit = 10000) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/v2/instance")) {
      return Response.json({
        configuration: {
          statuses: {
            max_characters: characterLimit,
            characters_reserved_per_url: 256,
          },
        },
      });
    }
    assert.ok(url.endsWith("/api/v1/statuses"));
    const postNumber = calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length;
    return Response.json({
      id: `status-${postNumber}`,
      url: `https://hollo.example/@blog/status-${postNumber}`,
      created_at: "2026-10-31T00:00:00.000Z",
    });
  };
  return { calls, fetchImpl };
}

test("RSS から記事の全文 HTML と正規化された URL を取得する", () => {
  const html = "<p>これは <strong>最初</strong> の段落です。</p><p>二段落目 &amp; 続き</p>";
  const [parsed] = parseRss(feed([item("first", "記事 & タイトル", html)]), blogUrl);
  assert.deepEqual(parsed, {
    path: "/posts/first/",
    title: "記事 & タイトル",
    contentHtml: html,
    url: "https://blog.example/posts/first/",
    publishedAt: "Sat, 31 Oct 2026 00:00:00 +0000",
  });
});

test("旧形式の RSS、不正な RSS、HTTP 以外の記事 URL を拒否する", () => {
  assert.throws(() => parseRss("<html></html>", blogUrl), /RSS 2.0/);
  assert.throws(() => parseRss("<rss><channel>", blogUrl), /RSS 2.0/);
  assert.throws(
    () => parseRss(feed([item("old")]).replace("<publisher:full-content>1</publisher:full-content>", ""), blogUrl),
    /does not include full content/,
  );
  assert.throws(
    () => parseRss(feed(["<item><title>記事</title><link>javascript:alert(1)</link></item>"]), blogUrl),
    /must be HTTP or HTTPS/,
  );
});

test("URL、タイトル、全文の順に並べ、3000 文字を超えても途中で切らない", () => {
  const text = `${"あ".repeat(3500)}最後の段落`;
  const status = createStatusText(article("long", "題名", `<p>冒頭</p><p>${text}</p>`));
  assert.equal(status, `${blogUrl}/posts/long/\n\n題名\n\n冒頭\n\n${text}`);
  assert.ok(Array.from(status).length > 3000);
});

test("画像、キャプション、相対リンク、コード、表を Markdown に変換する", () => {
  const html = [
    "<h2>見出し</h2>",
    '<p><a href="../reference/?a=1&amp;b=2">詳細</a>と<del>削除</del></p>',
    '<figure><img src="2026/photo.jpg" alt="図の説明" title="写真"><figcaption>画像のキャプション</figcaption></figure>',
    '<pre><code class="language-ts"><span>const   value = 1;</span>\n```\n</code></pre>',
    "<pre>  ```\n生のコード\n</pre>",
    '<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>A</td><td>一</td></tr><tr><td><code>a|b</code></td><td><a href="/pipe?a=1|2">リンク</a></td></tr></tbody></table>',
    '<ul><li><input type="checkbox" checked disabled> 完了</li><li><input type="checkbox" disabled> 未完</li></ul>',
    '<p><a href="/empty"><a href="/real">リンク</a></a><a href="/label" aria-label="補助ラベル"></a></p>',
  ].join("");
  const status = createStatusText(article("conversion", "題名", html));
  assert.match(status, /## 見出し/);
  assert.ok(status.includes("[詳細](https://blog.example/posts/reference/?a=1&b=2)"));
  assert.ok(status.includes("~~削除~~"));
  assert.ok(status.includes('![図の説明](https://blog.example/posts/conversion/2026/photo.jpg "写真")'));
  assert.ok(status.includes("画像のキャプション"));
  assert.ok(status.includes("````ts\nconst   value = 1;\n```\n````"));
  assert.ok(status.includes("````\n  ```\n生のコード\n````"));
  assert.match(status, /\| 項目 \| 値 \|\n\| --- \| --- \|\n\| A \| 一 \|/);
  assert.ok(status.includes("| `a\\|b` | [リンク](https://blog.example/pipe?a=1\\|2) |"));
  assert.ok(status.includes("[x]  完了"));
  assert.ok(status.includes("[ ]  未完"));
  assert.ok(status.includes("[リンク](https://blog.example/real)"));
  assert.ok(status.includes("[補助ラベル](https://blog.example/label)"));
  assert.doesNotMatch(status, /\[\]\(https:\/\/blog\.example\/empty\)/);
});

test("通常の文字を Markdown や数式として誤解釈しない", () => {
  const html = "<p>価格 $5 と $6、~~記号~~、&amp;amp;、&lt;文字&gt;、A | B</p><p>&gt; 引用ではない ~~~</p>";
  const status = createStatusText(article("symbols", "$ タイトル", html));
  assert.ok(status.includes("\\$ タイトル"));
  assert.ok(status.includes("価格 \\$5 と \\$6、\\~\\~記号\\~\\~、&amp;amp;、\\<文字\\>、A \\| B"));
  assert.ok(status.includes("\\> 引用ではない \\~\\~\\~"));
});

test("KaTeX の TeX を重複なく取り出し、行内数式と番号付き独立数式を保つ", () => {
  const inline = '<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">a^2+b^2=c^2</annotation></semantics></math></span><span class="katex-html">重複する表示</span></span>';
  const block = '<span class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">\\begin{aligned}\na&amp;=b\\\\\nc&amp;=d\\tag{1}\n\\end{aligned}</annotation></semantics></math><span class="katex-html"><svg></svg>重複する表示</span></span></span>';
  const status = createStatusText(article("math", "数式", `<p>行内 ${inline} です。</p>${block}`));
  assert.ok(status.includes("行内 $a^2+b^2=c^2$ です。"));
  assert.ok(status.includes("$$\n\\begin{aligned}\na&=b\\\\\nc&=d\\tag{1}\n\\end{aligned}\n$$"));
  assert.doesNotMatch(status, /重複する表示|<math|<svg/);
});

test("行内数式の隣に数字や別の数式がある場合も区切りを保つ", () => {
  const math = '<span class="katex"><annotation encoding="application/x-tex">x</annotation></span>';
  const status = createStatusText(article("math-adjacent", "数式", `<p>$${math}2 と ${math}${math}</p>`));
  assert.ok(status.includes("\\$\u200b$x$\u200b2 と $x$\u200b$x$"));
});

test("全文の欠落や変換できない要素を明示的に拒否する", () => {
  assert.throws(
    () => createStatusText({ path: "/posts/missing/", title: "題名", url: `${blogUrl}/posts/missing/` }),
    /has no full content/,
  );
  assert.throws(() => createStatusText(article("video", "動画", "<iframe></iframe>")), /iframe/);
  assert.throws(() => createStatusText(article("image", "画像", '<img src="data:image/png;base64,AA">')), /Unsupported image URL/);
  assert.throws(() => createStatusText(article("table", "表", "<table><tr><td>値</td></tr></table>")), /without a header row/);
  assert.throws(() => createStatusText(article("table", "表", "<table><thead><tr><th>項目</th></tr></thead><tbody><tr><td>一<br>二</td></tr></tbody></table>")), /inside table cells/);
  assert.throws(() => createStatusText(article("math", "数式", '<span class="katex">表示</span>')), /TeX from math/);
});

test("旧形式の RSS では初回の投稿済み状態を記録しない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(
    feedPath,
    feed([item("old")]).replace("<publisher:full-content>1</publisher:full-content>", ""),
  );
  const mock = mockHollo();
  const config = options(feedPath, join(directory, "posts.json"), mock.fetchImpl);

  await assert.rejects(publishNewItems(config), /does not include full content/);
  assert.equal(mock.calls.length, 0);
  const mapping = await loadPostMap(config.mapPath);
  assert.equal(mapping.initialized, false);
  assert.deepEqual(mapping.seenPaths, []);
});

test("初回の記事をスキップし、後から加わった記事だけを一度投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  await writeFile(feedPath, feed([item("old")]));
  const mock = mockHollo();
  const config = options(feedPath, mapPath, mock.fetchImpl);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 1, published: 0 });
  assert.equal(mock.calls.length, 0);

  await writeFile(feedPath, feed([item("new"), item("old")]));
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].url, "http://hollo:3000/api/v2/instance");
  assert.equal(mock.calls[1].url, "http://hollo:3000/api/v1/statuses");
  for (const call of mock.calls) {
    const forwarded = new Headers(call.init.headers);
    assert.equal(forwarded.get("x-forwarded-host"), "blog.example");
    assert.equal(forwarded.get("x-forwarded-proto"), "https");
  }
  const headers = new Headers(mock.calls[1].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${config.accessToken}`);
  assert.match(headers.get("idempotency-key") ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(String(mock.calls[1].init.body)), {
    status: `${blogUrl}/posts/new/\n\n記事 new\n\n本文 new\n\n二段落目`,
    visibility: "public",
    language: "ja",
  });
  const mapping = JSON.parse(await readFile(mapPath, "utf8"));
  assert.deepEqual(mapping.posts["/posts/new/"], {
    id: "status-1",
    url: "https://hollo.example/@blog/status-1",
    publishedAt: "2026-10-31T00:00:00.000Z",
  });
  assert.deepEqual(mapping.seenPaths, ["/posts/old/", "/posts/new/"]);
});

test("ローカル URL のポートとスキームを Hollo に伝える", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("local")]));
  const mock = mockHollo();
  const config = {
    ...options(feedPath, join(directory, "posts.json"), mock.fetchImpl, true),
    blogUrl: "http://127.0.0.1:28080",
  };
  await publishNewItems(config);
  for (const call of mock.calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("x-forwarded-host"), "127.0.0.1:28080");
    assert.equal(headers.get("x-forwarded-proto"), "http");
  }
  const post = JSON.parse(String(mock.calls[1].init.body));
  assert.ok(post.status.startsWith("http://127.0.0.1:28080/posts/local/"));
});

test("既存記事の初回投稿を許可した場合、重複する RSS 項目も一度だけ投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("old"), item("old")]));
  const mock = mockHollo();
  const config = options(feedPath, join(directory, "posts.json"), mock.fetchImpl, true);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.equal(mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length, 1);
  assert.equal((await loadPostMap(config.mapPath)).initialized, true);
});

test("公称上限ちょうどは投稿し、1 文字超過は記録せず、他の記事は投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const limit = 10000;
  const exactPrefix = `${blogUrl}/posts/exact/\n\n題名\n\n`;
  const longPrefix = `${blogUrl}/posts/long/\n\n題名\n\n`;
  const exactBody = "😀".repeat(limit - Array.from(exactPrefix).length);
  const longBody = "😀".repeat(limit - Array.from(longPrefix).length + 1);
  await writeFile(feedPath, feed([
    item("exact", "題名", `<p>${exactBody}</p>`),
    item("long", "題名", `<p>${longBody}</p>`),
    item("other"),
  ]));
  const mock = mockHollo(limit);
  const config = options(feedPath, mapPath, mock.fetchImpl, true);

  await assert.rejects(publishNewItems(config), /\/posts\/long\/.*10001 characters.*limit: 10000/);
  let posts = mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses"));
  assert.equal(posts.length, 2);
  assert.equal(Array.from(JSON.parse(String(posts[0].init.body)).status).length, limit);
  assert.ok(JSON.parse(String(posts[1].init.body)).status.includes("/posts/other/"));
  let mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.seenPaths, ["/posts/exact/", "/posts/other/"]);
  assert.equal(mapping.initialized, true);
  assert.equal(mapping.posts["/posts/long/"], undefined);

  await writeFile(feedPath, feed([item("exact"), item("long"), item("other")]));
  assert.deepEqual(
    await publishNewItems({ ...config, publishExistingOnFirstRun: false }),
    { baselineSkipped: 0, published: 1 },
  );
  posts = mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses"));
  assert.equal(posts.length, 3);
  mapping = await loadPostMap(mapPath);
  assert.ok(mapping.posts["/posts/long/"]);
});

test("全文が欠けた記事を記録せず、ほかの記事を投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const missing = `<item><title>欠落</title><link>${blogUrl}/posts/missing/</link><description>概要</description></item>`;
  await writeFile(feedPath, feed([missing, item("valid")]));
  const mock = mockHollo();
  const config = options(feedPath, join(directory, "posts.json"), mock.fetchImpl, true);

  await assert.rejects(publishNewItems(config), /\/posts\/missing\/.*has no full content/);
  const mapping = await loadPostMap(config.mapPath);
  assert.deepEqual(mapping.seenPaths, ["/posts/valid/"]);
  assert.ok(mapping.posts["/posts/valid/"]);
  assert.equal(mapping.posts["/posts/missing/"], undefined);
  assert.equal(mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length, 1);
});

test("Hollo の公称上限が取得できない場合は投稿しない", async (t) => {
  const cases: Array<{ name: string; response: () => Response; pattern: RegExp }> = [
    { name: "HTTP エラー", response: () => new Response("", { status: 503 }), pattern: /HTTP 503/ },
    { name: "不正な JSON", response: () => new Response("{"), pattern: /Failed to parse Hollo instance info as JSON/ },
    { name: "上限なし", response: () => Response.json({ configuration: { statuses: {} } }), pattern: /character limit is invalid/ },
    { name: "上限が 0", response: () => Response.json({ configuration: { statuses: { max_characters: 0 } } }), pattern: /character limit is invalid/ },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      await writeFile(feedPath, feed([item("new")]));
      let calls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        calls++;
        assert.ok(String(input).endsWith("/api/v2/instance"));
        return testCase.response();
      };
      const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);
      await assert.rejects(publishNewItems(config), testCase.pattern);
      assert.equal(calls, 1);
      const mapping = await loadPostMap(config.mapPath);
      assert.deepEqual(mapping.seenPaths, []);
      assert.deepEqual(Object.keys(mapping.posts), []);
    });
  }
});

test("Hollo が失敗した記事を対応表へ記録せず、エラーにトークンを含めない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("retry")]));
  const fetchImpl: typeof fetch = async (input) =>
    String(input).endsWith("/api/v2/instance")
      ? Response.json({ configuration: { statuses: { max_characters: 10000 } } })
      : new Response("sensitive response", { status: 503 });
  const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);

  await assert.rejects(publishNewItems(config), (error: Error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /test-token-never-log|sensitive response/);
    return true;
  });
  const mapping = await loadPostMap(config.mapPath);
  assert.deepEqual(mapping.seenPaths, []);
  assert.equal(Object.keys(mapping.posts).length, 0);
});

test("投稿対応表が壊れている場合は空の状態へ置き換えない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = join(directory, "posts.json");
  await writeFile(mapPath, "{broken");
  await assert.rejects(loadPostMap(mapPath), /Failed to parse post map JSON/);
});

test("環境変数の真偽値を検証し、トークン未設定を空文字として扱う", () => {
  const config = readConfig({
    BLOG_URL: "https://blog.example",
    PUBLISH_ENABLED: "false",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.publishExistingOnFirstRun, false);
  assert.equal(config.accessToken, "");
  assert.throws(() => readConfig({ PUBLISH_ENABLED: "yes" }), /true or false/);
  assert.throws(() => readConfig({ BLOG_URL: "https://user:password@blog.example/" }), /only a scheme and host/);
});

test("Hollo の投稿ページから記事へ移動するページを書き出す", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = join(directory, "posts.json");
  await writeFile(mapPath, JSON.stringify({
    version: 1,
    initialized: true,
    seenPaths: [],
    posts: {
      "/posts/a&b/": { id: "0193a", url: "https://blog.example/@blog/0193a" },
      "/posts/bad/": { id: "x", url: "https://blog.example/@blog/../../etc" },
    },
  }));

  assert.equal(await syncRemoteViewPages(mapPath, blogUrl), 1);
  const page = await readFile(join(remoteViewDirectory(mapPath), "@blog", "0193a.html"), "utf8");
  assert.match(page, /content="0; url=https:\/\/blog\.example\/posts\/a&amp;b\/"/);
  assert.equal(await syncRemoteViewPages(mapPath, blogUrl), 0);
});
