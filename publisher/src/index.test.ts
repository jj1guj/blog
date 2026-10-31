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
  type FeedItem,
  type PublisherOptions,
} from "./index.ts";

const blogUrl = "https://blog.example";
const feed = (items: string[]) =>
  `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items.join("")}</channel></rss>`;

function item(
  slug: string,
  title = `記事 ${slug}`,
  introduction = `本文 ${slug}`,
  publishedAt = "Sat, 31 Oct 2026 00:00:00 +0000",
): string {
  return `<item><title>${title}</title><link>${blogUrl}/posts/${slug}/</link><pubDate>${publishedAt}</pubDate><description>概要</description><content:encoded>&lt;p&gt;${introduction}&lt;/p&gt;&lt;p&gt;二段落目&lt;/p&gt;</content:encoded></item>`;
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

test("RSS から記事の最初の段落を抽出し、タイトルと URL を正規化する", () => {
  const [parsed] = parseRss(
    feed([
      item(
        "first",
        "記事 &amp; タイトル",
        "これは &lt;strong&gt;最初&lt;/strong&gt; の段落です。",
      ),
    ]),
    blogUrl,
  );
  assert.deepEqual(parsed, {
    path: "/posts/first/",
    title: "記事 & タイトル",
    introduction: "これは 最初 の段落です。",
    url: "https://blog.example/posts/first/",
    publishedAt: "Sat, 31 Oct 2026 00:00:00 +0000",
  });
});

test("Hugo RSS の content:encoded がない場合は description を使う", () => {
  const [parsed] = parseRss(
    feed([
      `<item><title>概要記事</title><link>/posts/summary/</link><description>&lt;p&gt;概要の文章&lt;/p&gt;</description></item>`,
    ]),
    blogUrl,
  );
  assert.equal(parsed.introduction, "概要の文章");
});

test("不正な RSS と不正な URL は明示的に拒否する", () => {
  assert.throws(() => parseRss("<html></html>", blogUrl), /RSS 2.0/);
  assert.throws(() => parseRss("<rss><channel>", blogUrl), /RSS 2.0/);
  assert.throws(
    () => parseRss(feed(["<item><title>記事</title><link>javascript:alert(1)</link></item>"]), blogUrl),
    /HTTP または HTTPS/,
  );
});

test("投稿本文にタイトル、冒頭、URLを含め、500文字以内に収める", () => {
  const article: FeedItem = {
    path: "/posts/long/",
    title: "題名",
    introduction: "あ".repeat(900),
    url: `${blogUrl}/posts/long/`,
  };
  const status = createStatusText(article);
  assert.match(status, /^題名\n\n/);
  assert.ok(status.endsWith(`\n\n${article.url}`));
  assert.ok(Array.from(status).length <= 500);
  assert.ok(status.includes("…"));
});

test("初回の既存記事をスキップし、後から加わった記事だけを一度投稿する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  const mapPath = join(directory, "posts.json");
  await writeFile(feedPath, feed([item("old")]));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return Response.json({
      id: "status-new",
      url: "https://hollo.example/@blog/status-new",
      created_at: "2026-10-31T00:00:00.000Z",
    });
  };
  const config = options(feedPath, mapPath, fetchImpl);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 1, published: 0 });
  assert.equal(calls.length, 0);

  await writeFile(feedPath, feed([item("new"), item("old")]));
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://hollo:3000/api/v1/statuses");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer test-token-never-log");
  assert.match(new Headers(calls[0].init.headers).get("idempotency-key") ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    status: `記事 new\n\n本文 new\n\n${blogUrl}/posts/new/`,
    visibility: "public",
    language: "ja",
  });
  const mapping = JSON.parse(await readFile(mapPath, "utf8"));
  assert.deepEqual(mapping.posts["/posts/new/"], {
    id: "status-new",
    url: "https://hollo.example/@blog/status-new",
    publishedAt: "2026-10-31T00:00:00.000Z",
  });
  assert.deepEqual(mapping.seenPaths, ["/posts/old/", "/posts/new/"]);
});

test("既存記事の初回投稿を許可した場合は記事を公開する", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("old")]));
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return Response.json({ id: "status-old", url: "https://hollo.example/@blog/status-old" });
  };
  const config = options(feedPath, join(directory, "posts.json"), fetchImpl, true);

  assert.deepEqual(await publishNewItems(config), { baselineSkipped: 0, published: 1 });
  assert.equal(calls, 1);
  assert.equal((await loadPostMap(config.mapPath)).initialized, true);
});

test("Hollo が失敗した記事を対応表へ記録せず、エラーにトークンを含めない", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hollo-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const feedPath = join(directory, "index.xml");
  await writeFile(feedPath, feed([item("retry")]));
  const config = options(
    feedPath,
    join(directory, "posts.json"),
    async () => new Response("sensitive response", { status: 503 }),
    true,
  );

  await assert.rejects(publishNewItems(config), (error: Error) => {
    assert.match(error.message, /HTTP 503/);
    assert.doesNotMatch(error.message, /test-token-never-log/);
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
  await assert.rejects(loadPostMap(mapPath), /JSON を読み取れません/);
});

test("環境変数の真偽値を検証し、トークン未設定を空文字として扱う", () => {
  const config = readConfig({
    BLOG_URL: "https://blog.example",
    PUBLISH_ENABLED: "false",
  });
  assert.equal(config.enabled, false);
  assert.equal(config.publishExistingOnFirstRun, false);
  assert.equal(config.accessToken, "");
  assert.throws(
    () => readConfig({ PUBLISH_ENABLED: "yes" }),
    /true または false/,
  );
});
