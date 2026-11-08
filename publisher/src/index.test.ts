import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  savePostMap,
  syncRemoteViewPages,
  type FeedItem,
  type PublisherOptions,
} from "./index.ts";
import { extractArticleImages } from "./markdown.ts";

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
            max_media_attachments: 8,
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

test("画像 URL と代替テキストを抽出し、フラグメント違いの重複をまとめる", () => {
  assert.deepEqual(extractArticleImages([
    '<figure><img src="photo.png#center" alt="図 &amp; 説明"></figure>',
    '<img src="/posts/images/photo.png#other" alt="重複">',
    '<img src="//images.example/other.jpg?size=2">',
  ].join(""), `${blogUrl}/posts/images/`), [
    { url: `${blogUrl}/posts/images/photo.png`, description: "図 & 説明" },
    { url: "https://images.example/other.jpg?size=2", description: "" },
  ]);
  assert.deepEqual(extractArticleImages("<p>画像なし</p>", blogUrl), []);
  assert.throws(() => extractArticleImages("<img>", blogUrl), /Image has no URL/);
  assert.throws(
    () => extractArticleImages('<img src="https://user:password@images.example/a.png">', blogUrl),
    /must not contain credentials/,
  );
});

test("記事バンドルと外部の画像を順にアップロードし、説明付きで新規投稿に添付する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await mkdir(join(directory, "posts", "images"), { recursive: true });
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await writeFile(join(directory, "posts", "images", "構成.png"), bytes);
  const html = [
    '<figure><img src="構成.png#center" alt="システム構成図"><figcaption>構成</figcaption></figure>',
    '<img src="./%E6%A7%8B%E6%88%90.png" alt="重複">',
    '<img src="https://images.example/other.jpg" alt="写真">',
  ].join("");
  await writeFile(feedPath, feed([item("images", "画像付き記事", html)]));
  const mock = mockHollo();
  const uploads: RequestInit[] = [];
  let downloads = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://images.example/other.jpg") {
      downloads++;
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("x-forwarded-host"), null);
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg" } });
    }
    if (url.endsWith("/api/v1/media")) {
      uploads.push(init);
      assert.equal(init.method, "POST");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer test-token-never-log");
      assert.equal(headers.get("x-forwarded-host"), "localhost:28080");
      assert.equal(headers.get("x-forwarded-proto"), "http");
      assert.equal(headers.get("content-type"), null);
      assert.ok(init.body instanceof FormData);
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
      assert.equal(file.type, uploads.length === 1 ? "image/png" : "image/jpeg");
      assert.equal(init.body.get("description"), uploads.length === 1 ? "システム構成図" : "写真");
      return Response.json({ id: `media-${uploads.length}` });
    }
    return mock.fetchImpl(input, init);
  };
  const config = {
    ...options(feedPath, join(directory, "posts.json"), fetchImpl, true),
    blogUrl: "http://localhost:28080",
  };
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  const posted = JSON.parse(String(mock.calls[1].init.body));
  assert.deepEqual(posted.media_ids, ["media-1", "media-2"]);
  assert.ok(posted.status.includes("![システム構成図]"));
  assert.ok(posted.status.includes("構成"));
  assert.equal(posted.visibility, "public");
  assert.equal(posted.language, "ja");
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
  assert.equal(uploads.length, 2);
  assert.equal(downloads, 1);
  assert.ok((await loadPostMap(config.mapPath)).posts["/posts/images/"]);
});

test("添付数上限に応じて分割し、不正な上限ではアップロード前に拒否する", async (t) => {
  for (const limit of [2, 1, 0, undefined, -1, 1.5]) {
    await t.test(`limit=${limit}`, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      await writeFile(feedPath, feed([item("limits", "画像", '<img src="/a.png"><img src="/b.png">')]));
      await writeFile(join(directory, "a.png"), "a");
      await writeFile(join(directory, "b.png"), "b");
      let uploaded = 0;
      const posted: Array<{ media_ids: string[]; in_reply_to_id?: string }> = [];
      const fetchImpl: typeof fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/api/v2/instance")) {
          return Response.json({
            configuration: {
              statuses: {
                max_characters: 10000,
                max_media_attachments: limit,
              }
            }
          });
        }
        if (url.endsWith("/api/v1/media")) {
          return Response.json({ id: `media-${++uploaded}` });
        }
        posted.push(JSON.parse(String(init.body)));
        const id = `status-${posted.length}`;
        return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
      };
      const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);
      if (limit === 2 || limit === 1) {
        assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
        assert.equal(uploaded, 2);
        assert.deepEqual(posted.map((post) => post.media_ids),
          limit === 2 ? [["media-1", "media-2"]] : [["media-1"], ["media-2"]]);
        if (limit === 1) assert.equal(posted[1].in_reply_to_id, "status-1");
      } else {
        await assert.rejects(publishNewItems(config), /attachment limit is invalid|does not permit images/);
        assert.equal(uploaded, 0);
        assert.equal(posted.length, 0);
        assert.deepEqual((await loadPostMap(config.mapPath)).seenPaths, []);
      }
    });
  }
});

test("画像の取得・アップロード失敗では記事を記録せず、他の記事を投稿する", async (t) => {
  const cases = [
    { name: "取得失敗", image: "https://images.example/a.png", download: () => new Response("", { status: 404 }), pattern: /HTTP 404/ },
    { name: "画像以外", image: "https://images.example/a.png", download: () => new Response("html", { headers: { "Content-Type": "text/html" } }), pattern: /no image content type/ },
    { name: "ローカル欠落", image: "/missing.png", pattern: /ENOENT/ },
    { name: "パス逸脱", image: "/..%2foutside.png", pattern: /outside the Hugo public directory/ },
    { name: "リンク先逸脱", image: "/outside.png", pattern: /outside the Hugo public directory/ },
    { name: "権限不足", image: "/a.png", upload: () => new Response("sensitive response", { status: 403 }), pattern: /HTTP 403/ },
    { name: "不正な JSON", image: "/a.png", upload: () => new Response("{"), pattern: /parse Hollo media response/ },
    { name: "ID 欠落", image: "/a.png", upload: () => Response.json({}), pattern: /media response has no id/ },
    { name: "空 ID", image: "/a.png", upload: () => Response.json({ id: "" }), pattern: /media response has no id/ },
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      await writeFile(feedPath, feed([
        item("failure", "画像", `<img src="${testCase.image}">`),
        item("valid"),
      ]));
      await writeFile(join(directory, "a.png"), "image");
      await symlink(tmpdir(), join(directory, "outside.png"));
      const mock = mockHollo();
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://images.example/")) {
          assert.ok(testCase.download);
          return testCase.download();
        }
        if (url.endsWith("/api/v1/media")) {
          assert.ok(testCase.upload);
          return testCase.upload();
        }
        return mock.fetchImpl(input, init);
      };
      const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);
      await assert.rejects(publishNewItems(config), (error: Error) => {
        assert.match(error.message, testCase.pattern);
        assert.doesNotMatch(error.message, /test-token-never-log|sensitive response/);
        return true;
      });
      const mapping = await loadPostMap(config.mapPath);
      assert.deepEqual(mapping.seenPaths, ["/posts/valid/"]);
      assert.equal(mapping.posts["/posts/failure/"], undefined);
      assert.equal(mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length, 1);
    });
  }
});

test("画像添付の失敗や投稿の明確な拒否後は再試行でき、投稿の冪等キーを保つ", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("retry-images", "画像", '<img src="/a.png"><img src="/b.png">')]));
  await writeFile(join(directory, "a.png"), "a");
  await writeFile(join(directory, "b.png"), "b");
  const mock = mockHollo();
  let uploads = 0;
  const statuses: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v1/media")) {
      uploads++;
      return uploads === 2
        ? new Response("", { status: 503 })
        : Response.json({ id: `media-${uploads}` });
    }
    if (url.endsWith("/api/v1/statuses")) {
      statuses.push(init);
      if (statuses.length === 1) return new Response("", { status: 422 });
    }
    return mock.fetchImpl(input, init);
  };
  const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);

  await assert.rejects(publishNewItems(config), /Failed to upload image.*HTTP 503/);
  assert.equal(statuses.length, 0);
  assert.deepEqual((await loadPostMap(config.mapPath)).seenPaths, []);
  await assert.rejects(publishNewItems(config), /Failed to post to Hollo.*HTTP 422/);
  assert.deepEqual((await loadPostMap(config.mapPath)).seenPaths, []);
  assert.deepEqual(JSON.parse(String(statuses[0].body)).media_ids, ["media-3", "media-4"]);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(JSON.parse(String(statuses[1].body)).media_ids, ["media-5", "media-6"]);
  const key = new Headers(statuses[0].headers).get("idempotency-key");
  assert.match(key ?? "", /^[a-f0-9]{64}$/);
  assert.equal(new Headers(statuses[1].headers).get("idempotency-key"), key);
  assert.ok((await loadPostMap(config.mapPath)).posts["/posts/retry-images/"]);
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
  assert.equal(uploads, 6);
  assert.equal(statuses.length, 2);
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

test("公称上限ちょうどは1投稿、1文字超過は返信に分けて投稿する", async (t) => {
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

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 3 });
  const posts = mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses"));
  assert.equal(posts.length, 4);
  assert.equal(Array.from(JSON.parse(String(posts[0].init.body)).status).length, limit);
  const first = JSON.parse(String(posts[1].init.body));
  const continuation = JSON.parse(String(posts[2].init.body));
  assert.equal(Array.from(first.status).length, limit);
  assert.equal(continuation.status, "😀");
  assert.equal(continuation.in_reply_to_id, "status-2");
  assert.equal(first.status + continuation.status, `${longPrefix}${longBody}`);
  assert.ok(JSON.parse(String(posts[3].init.body)).status.includes("/posts/other/"));
  const mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.seenPaths, ["/posts/exact/", "/posts/long/", "/posts/other/"]);
  assert.equal(mapping.initialized, true);
  assert.deepEqual(mapping.posts["/posts/long/"].replies?.map((reply) => reply.id), ["status-3"]);
  assert.deepEqual(
    await publishNewItems({ ...config, publishExistingOnFirstRun: false }),
    { baselineSkipped: 0, published: 0 },
  );
  assert.equal(mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length, 4);
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

test("投稿結果が不明な場合は、対応表の再読込後も自動再送しない", async (t) => {
  for (const outcome of ["timeout", "HTTP 503", "invalid JSON"]) {
    await t.test(outcome, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      const mapPath = join(directory, "posts.json");
      await writeFile(feedPath, feed([item("uncertain"), item("other")]));
      const mock = mockHollo();
      let attempts = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/api/v1/statuses") &&
          JSON.parse(String(init?.body)).status.includes("/posts/uncertain/")) {
          attempts++;
          assert.deepEqual((await loadPostMap(mapPath)).pendingPaths, ["/posts/uncertain/"]);
          if (outcome === "timeout") throw new DOMException("Timed out", "TimeoutError");
          return outcome === "HTTP 503"
            ? new Response("", { status: 503 })
            : new Response("{", { status: 200 });
        }
        return mock.fetchImpl(input, init);
      };
      const config = options(feedPath, mapPath, fetchImpl, true);
      await assert.rejects(publishNewItems(config));
      const mapping = await loadPostMap(mapPath);
      assert.deepEqual(mapping.pendingPaths, ["/posts/uncertain/"]);
      assert.ok(mapping.posts["/posts/other/"]);
      assert.equal(mapping.posts["/posts/uncertain/"], undefined);
      await assert.rejects(publishNewItems({ ...config }), /automatic retry is blocked/);
      assert.equal(attempts, 1);
    });
  }
});

test("Hollo が投稿を明確に拒否した場合は修正後に再試行できる", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  await writeFile(feedPath, feed([item("rejected")]));
  const mock = mockHollo();
  const fetchImpl: typeof fetch = async (input, init) =>
    String(input).endsWith("/api/v1/statuses")
      ? new Response("", { status: 422 })
      : mock.fetchImpl(input, init);
  await assert.rejects(publishNewItems(options(feedPath, mapPath, fetchImpl, true)), /HTTP 422/);
  assert.deepEqual((await loadPostMap(mapPath)).pendingPaths, []);
  await publishNewItems(options(feedPath, mapPath, mock.fetchImpl, true));
  assert.ok((await loadPostMap(mapPath)).posts["/posts/rejected/"]);
  assert.deepEqual((await loadPostMap(mapPath)).pendingPaths, []);
});

test("投稿対応表が壊れている場合は空の状態へ置き換えない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = join(directory, "posts.json");
  await writeFile(mapPath, "{broken");
  await assert.rejects(loadPostMap(mapPath), /Failed to parse post map JSON/);
  for (const pendingPaths of ["/posts/uncertain/", [42], ["not-a-path"]]) {
    await writeFile(mapPath, JSON.stringify({
      version: 1,
      initialized: true,
      seenPaths: [],
      posts: {},
      pendingPaths,
    }));
    await assert.rejects(loadPostMap(mapPath), /Post map has an invalid format/);
  }
});

test("不正なスレッド進捗は読み込み時に拒否して対応表を保持する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = join(directory, "posts.json");
  const path = "/posts/broken-thread/";
  const root = { id: "root", url: `${blogUrl}/@blog/root` };
  const part = { status: "本文", images: [] };
  const image = { url: "https://images.example/a.png", description: "" };
  const base = { version: 1, initialized: true, seenPaths: [], posts: {} };
  const cases = [
    { ...base, threads: { [path]: { parts: [] } } },
    { ...base, threads: { [path]: { parts: [{ status: "", images: [] }] } } },
    { ...base, threads: { [path]: { parts: [{ ...part, images: [{ ...image, url: `${image.url}#x` }] }] } } },
    { ...base, threads: { [path]: { parts: [{ ...part, images: [image, image] }] } } },
    { ...base, seenPaths: [path], threads: { [path]: { parts: [part] } } },
    { ...base, posts: { [path]: { ...root, replies: [root] } } },
    {
      ...base,
      posts: { [path]: { ...root, replies: [{ id: "reply", url: `${blogUrl}/@blog/reply` }] } },
      threads: { [path]: { parts: [part] } },
    },
    {
      ...base,
      posts: { [path]: root },
      pendingPaths: [path],
      threads: { [path]: { parts: [part] } },
    },
  ];

  for (const value of cases) {
    const contents = JSON.stringify(value);
    await writeFile(mapPath, contents);
    await assert.rejects(loadPostMap(mapPath), /Post map contains/);
    assert.equal(await readFile(mapPath, "utf8"), contents);
  }
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

test("RSS のタグを取得し、本文の末尾にハッシュタグとして付ける", () => {
  const tagged = item("tagged").replace(
    "<content:encoded>",
    "<category>プログラミング</category><category>Hugo &amp; Hollo</category><category>hugo</category><category> </category><content:encoded>",
  );
  const [parsed] = parseRss(feed([tagged]), blogUrl);
  assert.deepEqual(parsed.tags, ["プログラミング", "Hugo & Hollo", "hugo"]);
  const status = createStatusText(parsed);
  assert.ok(status.endsWith("\n\n#プログラミング #HugoHollo #hugo"));

  const [untagged] = parseRss(feed([item("untagged")]), blogUrl);
  assert.equal(untagged.tags, undefined);
  assert.ok(!createStatusText(untagged).includes("#"));
});

test("17枚の画像を8枚ずつ返信に添付し、各投稿の進捗と移動先を保存する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const path = "/posts/many-images/";
  const html = Array.from({ length: 17 }, (_, index) =>
    `<p>画像${index}<img src="/${index}.png" alt="画像${index}"></p>`,
  ).join("") + '<p><img src="/0.png#center" alt="重複"></p>';
  await writeFile(feedPath, feed([item("many-images", "画像", html)]));
  await Promise.all(Array.from({ length: 17 }, (_, index) =>
    writeFile(join(directory, `${index}.png`), `image-${index}`),
  ));
  const uploaded: string[] = [];
  const statuses: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 10000, max_media_attachments: 8 } } });
    }
    if (url.endsWith("/api/v1/media")) {
      assert.ok(init.body instanceof FormData);
      uploaded.push(String(init.body.get("description")));
      return Response.json({ id: `media-${uploaded.length}` });
    }
    const map = await loadPostMap(mapPath);
    assert.deepEqual(map.pendingPaths, [path]);
    assert.equal(map.threads?.[path].parts.length, 3);
    assert.equal(map.posts[path] ? 1 + (map.posts[path].replies?.length ?? 0) : 0, statuses.length);
    statuses.push({
      body: JSON.parse(String(init.body)),
      key: new Headers(init.headers).get("idempotency-key"),
    });
    const id = `status-${statuses.length}`;
    return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
  };
  const config = options(feedPath, mapPath, fetchImpl, true);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(uploaded, Array.from({ length: 17 }, (_, index) => `画像${index}`));
  assert.deepEqual(statuses.map(({ body }) => body.media_ids), [
    Array.from({ length: 8 }, (_, index) => `media-${index + 1}`),
    Array.from({ length: 8 }, (_, index) => `media-${index + 9}`),
    ["media-17"],
  ]);
  assert.equal(statuses[0].body.in_reply_to_id, undefined);
  assert.equal(statuses[1].body.in_reply_to_id, "status-1");
  assert.equal(statuses[2].body.in_reply_to_id, "status-2");
  assert.equal(statuses[0].key, createHash("sha256").update(path).digest("hex"));
  assert.equal(new Set(statuses.map(({ key }) => key)).size, 3);
  for (const [index, status] of statuses.entries()) {
    assert.ok(String(status.body.status).includes(`/${index * 8}.png`));
    assert.ok(Array.from(String(status.body.status)).length <= 10000);
    const page = await readFile(
      join(remoteViewDirectory(mapPath), "@blog", `status-${index + 1}.html`),
      "utf8",
    );
    assert.ok(page.includes(`${blogUrl}${path}`));
  }
  const mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.posts[path].replies?.map((reply) => reply.id), ["status-2", "status-3"]);
  assert.deepEqual(mapping.pendingPaths, []);
  assert.equal(mapping.threads?.[path], undefined);
  assert.deepEqual(mapping.seenPaths, [path]);
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
  assert.equal(uploaded.length, 17);
  assert.equal(statuses.length, 3);
});

test("切れないリンク内の余分な画像は本文なしの返信として添付する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const html = `<a href="/reference">${Array.from({ length: 3 }, (_, index) =>
    `<img src="/${index}.png" alt="${index}">`,
  ).join("")}</a>`;
  await writeFile(feedPath, feed([item("linked-images", "画像", html)]));
  await Promise.all(Array.from({ length: 3 }, (_, index) =>
    writeFile(join(directory, `${index}.png`), "image"),
  ));
  let uploaded = 0;
  const statuses: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 10000, max_media_attachments: 2 } } });
    }
    if (url.endsWith("/api/v1/media")) return Response.json({ id: `media-${++uploaded}` });
    statuses.push(JSON.parse(String(init.body)));
    const id = `status-${statuses.length}`;
    return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
  };

  assert.deepEqual(
    await publishNewItems(options(feedPath, join(directory, "posts.json"), fetchImpl, true)),
    { baselineSkipped: 0, published: 1 },
  );
  assert.deepEqual(statuses.map((status) => (status.media_ids as string[] | undefined)?.length ?? 0), [0, 2, 1]);
  assert.ok(String(statuses[1].status).includes("/reference"));
  assert.equal(Object.hasOwn(statuses[2], "status"), false);
  assert.equal(statuses[2].in_reply_to_id, "status-2");
});

test("後続画像のアップロード失敗後は、成功済みの投稿や画像を再送しない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const path = "/posts/image-retry/";
  const html = Array.from({ length: 9 }, (_, index) =>
    `<p><img src="/${index}.png" alt="${index}"></p>`,
  ).join("");
  await writeFile(feedPath, feed([item("image-retry", "画像", html)]));
  await Promise.all(Array.from({ length: 9 }, (_, index) =>
    writeFile(join(directory, `${index}.png`), "image"),
  ));
  const descriptions: string[] = [];
  const statuses: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 10000, max_media_attachments: 8 } } });
    }
    if (url.endsWith("/api/v1/media")) {
      assert.ok(init.body instanceof FormData);
      descriptions.push(String(init.body.get("description")));
      if (descriptions.length === 9) return new Response("", { status: 503 });
      return Response.json({ id: `media-${descriptions.length}` });
    }
    statuses.push(JSON.parse(String(init.body)));
    const id = `status-${statuses.length}`;
    return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
  };
  const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);

  await assert.rejects(publishNewItems(config), /Part 2\/2: Failed to upload image.*HTTP 503/);
  let mapping = await loadPostMap(config.mapPath);
  assert.equal(mapping.posts[path].id, "status-1");
  assert.equal(mapping.threads?.[path].parts.length, 2);
  assert.deepEqual(mapping.pendingPaths, []);
  assert.deepEqual(mapping.seenPaths, []);
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(descriptions, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "8"]);
  assert.equal(statuses.length, 2);
  assert.equal(statuses[1].in_reply_to_id, "status-1");
  mapping = await loadPostMap(config.mapPath);
  assert.equal(mapping.posts[path].replies?.[0].id, "status-2");
});

test("返信が明確に拒否されたら、RSS から記事が消えても保存済み本文から再開する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const path = "/posts/thread-retry/";
  await writeFile(feedPath, feed([item("thread-retry", "長い記事", `<p>${"本文".repeat(400)}</p>`), item("other")]));
  const calls: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  let successful = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input).endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 250, max_media_attachments: 8 } } });
    }
    calls.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
    if (calls.length === 2) return new Response("", { status: 422 });
    const id = `status-${++successful}`;
    return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
  };
  const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);

  await assert.rejects(publishNewItems(config), /Part 2\/.*HTTP 422/);
  let mapping = await loadPostMap(config.mapPath);
  assert.equal(mapping.posts[path].id, "status-1");
  assert.ok(mapping.posts["/posts/other/"]);
  assert.deepEqual(mapping.pendingPaths, []);
  assert.deepEqual(mapping.seenPaths, ["/posts/other/"]);
  const snapshot = mapping.threads?.[path].parts.map((part) => part.status).join("");
  assert.ok(snapshot?.includes("本文".repeat(400)));

  await writeFile(feedPath, feed([item("other")]));
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(calls[3].body, calls[1].body);
  assert.equal(calls[3].key, calls[1].key);
  assert.equal(calls.filter(({ body }) => String(body.status).includes(`${blogUrl}${path}`)).length, 1);
  mapping = await loadPostMap(config.mapPath);
  assert.ok(mapping.posts[path].replies?.length);
  assert.equal(mapping.threads?.[path], undefined);
  assert.ok(mapping.seenPaths.includes(path));
});

test("返信の投稿結果が不明な場合、再起動相当の再読込後も再送しない", async (t) => {
  for (const outcome of ["timeout", "HTTP 408", "HTTP 503", "invalid JSON", "missing ID", "duplicate ID"]) {
    await t.test(outcome, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      const mapPath = join(directory, "posts.json");
      const path = "/posts/uncertain-thread/";
      await writeFile(feedPath, feed([item("uncertain-thread", "記事", `<p>${"文".repeat(700)}</p>`)]));
      const statuses: Array<Record<string, unknown>> = [];
      const fetchImpl: typeof fetch = async (input, init = {}) => {
        if (String(input).endsWith("/api/v2/instance")) {
          return Response.json({ configuration: { statuses: { max_characters: 200, max_media_attachments: 8 } } });
        }
        const mapping = await loadPostMap(mapPath);
        assert.deepEqual(mapping.pendingPaths, [path]);
        assert.ok(mapping.threads?.[path]);
        statuses.push(JSON.parse(String(init.body)));
        if (statuses.length === 3) {
          if (outcome === "timeout") throw new DOMException("Timed out", "TimeoutError");
          if (outcome === "HTTP 408") return new Response("", { status: 408 });
          if (outcome === "HTTP 503") return new Response("", { status: 503 });
          if (outcome === "invalid JSON") return new Response("{", { status: 200 });
          if (outcome === "missing ID") return Response.json({ url: `${blogUrl}/@blog/missing` });
          return Response.json({ id: "status-2", url: `${blogUrl}/@blog/status-2` });
        }
        const id = `status-${statuses.length}`;
        return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
      };
      const config = options(feedPath, mapPath, fetchImpl, true);

      await assert.rejects(publishNewItems(config), /Part 3\//);
      const mapping = await loadPostMap(mapPath);
      assert.equal(mapping.posts[path].id, "status-1");
      assert.deepEqual(mapping.posts[path].replies?.map((reply) => reply.id), ["status-2"]);
      assert.deepEqual(mapping.pendingPaths, [path]);
      assert.deepEqual(mapping.seenPaths, []);
      assert.equal(statuses[1].in_reply_to_id, "status-1");
      assert.equal(statuses[2].in_reply_to_id, "status-2");
      await assert.rejects(publishNewItems({ ...config }), /automatic retry is blocked/);
      assert.equal(statuses.length, 3);
    });
  }
});

test("結果不明の最終返信を手動で照合した後、再送せず完了として記録する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const path = "/posts/reconciled/";
  await writeFile(feedPath, feed([item("reconciled", "記事", `<p>${"文".repeat(130)}</p>`)]));
  let attempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 100, max_media_attachments: 8 } } });
    }
    attempts++;
    if (attempts === 2) throw new DOMException("Timed out", "TimeoutError");
    return Response.json({ id: "root", url: `${blogUrl}/@blog/root` });
  };
  const config = options(feedPath, mapPath, fetchImpl, true);

  await assert.rejects(publishNewItems(config), /Part 2\/2/);
  const mapping = await loadPostMap(mapPath);
  mapping.posts[path].replies = [{ id: "confirmed-reply", url: `${blogUrl}/@blog/confirmed-reply` }];
  mapping.pendingPaths = [];
  await savePostMap(mapPath, mapping);
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.equal(attempts, 2);
  const finalMap = await loadPostMap(mapPath);
  assert.deepEqual(finalMap.seenPaths, [path]);
  assert.equal(finalMap.threads?.[path], undefined);
  assert.ok((await readFile(join(remoteViewDirectory(mapPath), "@blog", "confirmed-reply.html"), "utf8"))
    .includes(`${blogUrl}${path}`));
});

test("結果不明の先頭投稿を手動で照合した後、返信から重複なく再開する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const path = "/posts/reconciled-root/";
  await writeFile(feedPath, feed([item("reconciled-root", "記事", `<p>${"文".repeat(400)}</p>`)]));
  const statuses: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input).endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 200, max_media_attachments: 8 } } });
    }
    statuses.push({
      body: JSON.parse(String(init.body)),
      key: new Headers(init.headers).get("idempotency-key"),
    });
    if (statuses.length === 1) throw new DOMException("Timed out", "TimeoutError");
    const id = `reply-${statuses.length - 1}`;
    return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
  };
  const config = options(feedPath, mapPath, fetchImpl, true);

  await assert.rejects(publishNewItems(config), /Part 1\//);
  let mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.pendingPaths, [path]);
  assert.equal(mapping.posts[path], undefined);
  mapping.posts[path] = { id: "confirmed-root", url: `${blogUrl}/@blog/confirmed-root` };
  mapping.pendingPaths = [];
  await savePostMap(mapPath, mapping);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.equal(statuses[0].body.in_reply_to_id, undefined);
  assert.equal(statuses[1].body.in_reply_to_id, "confirmed-root");
  assert.equal(new Set(statuses.map(({ key }) => key)).size, statuses.length);
  mapping = await loadPostMap(mapPath);
  assert.equal(mapping.posts[path].id, "confirmed-root");
  assert.equal(mapping.posts[path].replies?.length, statuses.length - 1);
  assert.deepEqual(mapping.seenPaths, [path]);
  assert.equal(mapping.threads?.[path], undefined);
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
});

test("途中で公称上限が下がった場合、未投稿部分を送らず上限の復旧後に再開する", async (t) => {
  for (const kind of ["characters", "media"] as const) {
    await t.test(kind, async (subtest) => {
      const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
      subtest.after(() => rm(directory, { recursive: true, force: true }));
      const feedPath = join(directory, "index.xml");
      const mapPath = join(directory, "posts.json");
      const path = `/posts/lowered-${kind}/`;
      const html = kind === "characters"
        ? `<p>${"文".repeat(500)}</p>`
        : Array.from({ length: 16 }, (_, index) =>
          `<p><img src="/${index}.png" alt="${index}"></p>`,
        ).join("");
      await writeFile(feedPath, feed([item(`lowered-${kind}`, "記事", html)]));
      if (kind === "media") {
        await Promise.all(Array.from({ length: 16 }, (_, index) =>
          writeFile(join(directory, `${index}.png`), "image"),
        ));
      }
      let characterLimit = kind === "characters" ? 200 : 10000;
      let mediaLimit = 8;
      let uploaded = 0;
      const statuses: Array<{ body: Record<string, unknown>; key: string | null }> = [];
      const fetchImpl: typeof fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/api/v2/instance")) {
          return Response.json({
            configuration: { statuses: { max_characters: characterLimit, max_media_attachments: mediaLimit } },
          });
        }
        if (url.endsWith("/api/v1/media")) return Response.json({ id: `media-${++uploaded}` });
        statuses.push({
          body: JSON.parse(String(init.body)),
          key: new Headers(init.headers).get("idempotency-key"),
        });
        if (statuses.length === 2) return new Response("", { status: 422 });
        const id = statuses.length === 1 ? "root" : `reply-${statuses.length}`;
        return Response.json({ id, url: `${blogUrl}/@blog/${id}` });
      };
      const config = options(feedPath, mapPath, fetchImpl, true);

      await assert.rejects(publishNewItems(config), /Part 2\/.*HTTP 422/);
      assert.equal((await loadPostMap(mapPath)).posts[path].id, "root");
      const uploadsBeforeLimitChange = uploaded;
      if (kind === "characters") characterLimit = 50;
      else mediaLimit = 4;
      await assert.rejects(
        publishNewItems(config),
        kind === "characters" ? /current Hollo character limit/ : /current Hollo media attachment limit/,
      );
      assert.equal(statuses.length, 2);
      assert.equal(uploaded, uploadsBeforeLimitChange);

      characterLimit = kind === "characters" ? 200 : 10000;
      mediaLimit = 8;
      assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
      assert.equal(statuses[2].body.in_reply_to_id, "root");
      assert.equal(statuses[2].key, statuses[1].key);
      assert.equal(statuses.filter(({ body }) => body.in_reply_to_id === undefined).length, 1);
      const mapping = await loadPostMap(mapPath);
      assert.ok(mapping.seenPaths.includes(path));
      assert.equal(mapping.threads?.[path], undefined);
    });
  }
});

test("長すぎるリンクは最初の画像アップロードや投稿前に拒否し、他の記事は投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const link = `https://example.test/${"x".repeat(10000)}`;
  const html = `<p><img src="/image.png"><a href="${link}">長いリンク</a></p>`;
  await writeFile(feedPath, feed([item("oversized-link", "記事", html), item("other")]));
  const mock = mockHollo();
  let uploads = 0;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    if (String(input).endsWith("/api/v1/media")) {
      uploads++;
      return Response.json({ id: "image" });
    }
    return mock.fetchImpl(input, init);
  };
  const config = options(feedPath, mapPath, fetchImpl, true);

  await assert.rejects(publishNewItems(config), /\/posts\/oversized-link\/.*construct or link exceeds/);
  assert.equal(uploads, 0);
  const statuses = mock.calls.filter(({ url }) => url.endsWith("/api/v1/statuses"));
  assert.equal(statuses.length, 1);
  assert.ok(String(statuses[0].init.body).includes("/posts/other/"));
  const mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.seenPaths, ["/posts/other/"]);
  assert.equal(mapping.posts["/posts/oversized-link/"], undefined);
  assert.equal(mapping.threads?.["/posts/oversized-link/"], undefined);
});

test("投稿成功後に対応表の保存に失敗しても、自動再送を停止する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  const temporaryPath = `${mapPath}.${process.pid}.tmp`;
  await writeFile(feedPath, feed([item("save-failure")]));
  let attempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith("/api/v2/instance")) {
      return Response.json({ configuration: { statuses: { max_characters: 10000, max_media_attachments: 8 } } });
    }
    attempts++;
    await mkdir(temporaryPath);
    return Response.json({ id: "created", url: `${blogUrl}/@blog/created` });
  };
  const config = options(feedPath, mapPath, fetchImpl, true);

  await assert.rejects(publishNewItems(config));
  await rm(temporaryPath, { recursive: true, force: true });
  const mapping = await loadPostMap(mapPath);
  assert.deepEqual(mapping.pendingPaths, ["/posts/save-failure/"]);
  assert.equal(mapping.posts["/posts/save-failure/"], undefined);
  await assert.rejects(publishNewItems(config), /automatic retry is blocked/);
  assert.equal(attempts, 1);
});

test("旧形式の結果不明な投稿は分割対応後も自動再送しない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  await writeFile(feedPath, feed([item("legacy-pending")]));
  await writeFile(mapPath, JSON.stringify({
    version: 1,
    initialized: true,
    seenPaths: [],
    posts: {},
    pendingPaths: ["/posts/legacy-pending/"],
  }));
  const mock = mockHollo();
  await assert.rejects(publishNewItems(options(feedPath, mapPath, mock.fetchImpl, true)), /automatic retry is blocked/);
  assert.equal(mock.calls.filter((call) => call.url.endsWith("/api/v1/statuses")).length, 0);
});
