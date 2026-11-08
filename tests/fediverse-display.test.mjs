import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(new URL("../publisher/package.json", import.meta.url));
const domino = require("@mixmark-io/domino");
const script = readFileSync(new URL("../assets/js/blog-federation.js", import.meta.url), "utf8");
const headTemplate = readFileSync(
  new URL("../layouts/_partials/extend_head.html", import.meta.url),
  "utf8",
);
const metricsTemplate = readFileSync(
  new URL("../layouts/_partials/post_metrics.html", import.meta.url),
  "utf8",
).replace(/\{\{.*?\}\}/g, "");
const commentsTemplate = readFileSync(
  new URL("../layouts/_partials/extend_post_content.html", import.meta.url),
  "utf8",
).replace(/\{\{.*?\}\}/g, "");
const template = readFileSync(new URL("../layouts/single.html", import.meta.url), "utf8")
  .replace('{{- partial "post_metrics.html" . }}', metricsTemplate)
  .replace('{{- partial "extend_post_content.html" . }}', commentsTemplate)
  .replace(/\{\{[\s\S]*?\}\}/g, "");

const origin = "https://blog.example";
const postPath = "/posts/example/";
const statusPath = "/api/v1/statuses/status-1";

function comment(id, createdAt, content = `<p>${id}</p>`) {
  return {
    id,
    created_at: createdAt,
    content,
    url: `https://remote.example/status/${id}`,
    account: {
      display_name: `Author ${id}`,
      acct: `${id}@remote.example`,
      url: `https://remote.example/@${id}`,
      avatar: `https://remote.example/avatar/${id}.png`,
    },
  };
}

function createBrowser(options = {}) {
  const window = domino.createWindow(
    `<html><head></head><body><nav><ul id="menu"></ul></nav>${template}</body></html>`,
  );
  const { document, Element, Node } = window;
  if (options.canonicalUrl) {
    const canonical = document.createElement("link");
    canonical.setAttribute("rel", "canonical");
    canonical.setAttribute("href", options.canonicalUrl);
    document.head.appendChild(canonical);
  }
  if (!("append" in Node.prototype)) {
    Object.defineProperty(Node.prototype, "append", {
      value(...items) {
        for (const item of items) {
          this.appendChild(typeof item === "string" ? this.ownerDocument.createTextNode(item) : item);
        }
      },
    });
  }
  if (!("dataset" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "dataset", {
      get() {
        return {
          postPath: this.getAttribute("data-post-path"),
          mediaProxyUrl: this.getAttribute("data-media-proxy-url"),
        };
      },
    });
  }
  const panel = document.querySelector("[data-fediverse-stats]");
  assert.ok(panel);
  panel.setAttribute("data-post-path", postPath);
  panel.setAttribute("data-media-proxy-url", options.mediaProxyUrl ?? "https://proxy.example");

  const requests = [];
  const errors = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    if (url.pathname === "/api/v1/accounts/lookup") {
      return Response.json({ followers_count: 7 });
    }
    if (url.pathname.startsWith("/gc/counter/")) {
      return options.viewResponse ? options.viewResponse(url) : Response.json({ count: "12" });
    }
    if (url.pathname === "/fediverse/posts.json") {
      return Response.json({
        posts: options.unpublished ? {} : { [postPath]: options.post ?? { id: "status-1" } },
        ...(options.pendingPaths !== undefined ? { pendingPaths: options.pendingPaths } : {}),
        ...(options.threads !== undefined ? { threads: options.threads } : {}),
      });
    }
    if (url.pathname === statusPath) {
      return Response.json({
        url: `${origin}/@blog/status-1`,
        favourites_count: 2,
        reblogs_count: 3,
        replies_count: 99,
        quotes_count: 99,
        emoji_reactions: options.reactions ?? [
          { name: "clap", url: "https://remote.example/clap.png", count: 2 },
          { name: "👍", count: 1 },
        ],
      });
    }
    if (url.pathname === `${statusPath}/context`) {
      if (options.contextError) return new Response("", { status: 503 });
      return Response.json({ descendants: options.replies ?? [] });
    }
    if (/^\/api\/v1\/statuses\/[^/]+\/quotes$/.test(url.pathname)) {
      if (options.quoteError) return new Response("", { status: 503 });
      if (options.quoteResponse) return options.quoteResponse(url);
      if (options.quotesByStatus) {
        const statusId = decodeURIComponent(url.pathname.split("/")[4]);
        return Response.json(options.quotesByStatus[statusId] ?? []);
      }
      return Response.json(options.quotes ?? []);
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  class DOMParser {
    parseFromString(html, type) {
      assert.equal(type, "text/html");
      return domino.createDocument(`<html><head></head><body>${html}</body></html>`);
    }
  }

  const context = vm.createContext({
    document,
    Element,
    Node,
    DOMParser,
    URL,
    AbortSignal,
    Intl,
    location: new URL(options.pageUrl ?? `${origin}${postPath}`),
    fetch,
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(script, context, { filename: "blog-federation.js" });
  return { document, panel, requests, errors };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the display to update");
}

test("反応は日付の直下に置き、コメント数と一覧だけをフッターに置く", async () => {
  const browser = createBrowser({
    replies: [comment("reply", "2026-11-01T10:00:00Z")],
  });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  const { document, panel } = browser;
  const header = document.querySelector(".post-header");
  const footer = document.querySelector(".post-footer");
  assert.equal(panel.parentNode, header);
  assert.equal(panel.previousElementSibling.className, "post-meta");
  assert.ok(header.querySelector("[data-reactions]"));
  assert.ok(header.querySelector("[data-status-link]"));
  assert.ok(!header.querySelector("[data-comment-count]"));
  assert.equal(document.querySelector("[data-replies]").parentNode, footer);
  assert.equal(footer.querySelector("h2").textContent, "コメント（1）");
  assert.ok(!footer.querySelector("[data-view-count]"));
  assert.ok(!footer.querySelector("[data-fediverse-count]"));
});

test("返信と複数ページの引用を時系列で統合し、重複を除いて安全に表示する", async () => {
  const reply = comment("reply", "2026-11-01T10:00:00Z");
  const both = comment("both", "2026-11-01T10:01:00Z");
  const quote = comment(
    "quote",
    "2026-11-01T10:02:00Z",
    '<p>引用 <strong>本文</strong><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">危険</a><a href="https://remote.example/link">安全</a></p>',
  );
  const laterQuote = comment("later", "2026-11-01T10:03:00Z");
  const browser = createBrowser({
    replies: [both, reply],
    quoteResponse(url) {
      if (!url.searchParams.has("max_id")) {
        return Response.json([quote, both], {
          headers: {
            Link: `<http://hollo-internal:3000${statusPath}/quotes?limit=40&max_id=page-2>; rel="next"`,
          },
        });
      }
      assert.equal(url.searchParams.get("max_id"), "page-2");
      return Response.json([laterQuote]);
    },
  });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  const { document, requests, errors } = browser;
  assert.equal(document.querySelector('[data-count="comments"]').textContent, "4");
  assert.equal(document.querySelector('[data-count="favourites_count"]').textContent, "2");
  assert.equal(document.querySelector('[data-count="reblogs_count"]').textContent, "3");
  assert.equal(document.querySelector('[data-count="emoji_reactions"]').textContent, "3");
  assert.equal(document.querySelector("[data-view-count-value]").textContent, "12");
  assert.ok(!document.querySelector('[data-count="quotes_count"]'));
  assert.equal(document.querySelectorAll(".fediverse-stats-list svg").length, 4);
  assert.deepEqual(
    Array.from(document.querySelectorAll(".fediverse-stat-label"), (label) => label.textContent.trim()),
    ["閲覧数", "いいね", "ブースト", "リアクション"],
  );
  const profile = document.querySelector(".fediverse-profile");
  assert.equal(profile.getAttribute("href"), `${origin}/@blog?view=fediverse`);
  assert.equal(
    document.querySelector("[data-status-link]").getAttribute("href"),
    `${origin}/@blog/status-1?view=fediverse`,
  );
  assert.equal(
    document.head.querySelector('link[rel="alternate"][type="application/activity+json"]').getAttribute("href"),
    `${origin}/@blog/status-1`,
  );
  assert.equal(profile.textContent, "@blog@blog.example · フォロワー 7");

  const contents = Array.from(document.querySelectorAll(".fediverse-reply-content"));
  assert.equal(contents.length, 4);
  assert.equal(contents[0].textContent, "reply");
  assert.equal(contents[1].textContent, "both");
  assert.equal(contents[2].textContent, "引用 本文危険安全");
  assert.equal(contents[3].textContent, "later");
  assert.ok(!contents[2].querySelector("script"));
  assert.ok(!contents[2].querySelector("img"));
  assert.ok(!contents[2].querySelector('a[href^="javascript:"]'));
  assert.ok(contents[2].querySelector('a[href="https://remote.example/link"]'));

  const avatar = new URL(document.querySelector(".fediverse-reply-avatar").getAttribute("src"));
  assert.equal(avatar.origin, "https://proxy.example");
  assert.equal(avatar.searchParams.get("avatar"), "1");
  const emoji = new URL(document.querySelector("[data-reactions] img").getAttribute("src"));
  assert.equal(emoji.searchParams.get("emoji"), "1");
  assert.equal(emoji.searchParams.get("url"), "https://remote.example/clap.png");

  const quoteRequests = requests.filter(({ url }) => url.pathname === `${statusPath}/quotes`);
  assert.equal(quoteRequests.length, 2);
  assert.ok(quoteRequests.every(({ url }) => url.origin === origin));
  assert.ok(requests.every(({ init }) => !new Headers(init.headers).has("authorization")));
  assert.deepEqual(errors, []);
});

test("記事の続きはコメントから除外し、続きへの返信と引用は表示する", async () => {
  const firstContinuation = comment("status-2", "2026-11-01T10:00:00Z");
  const secondContinuation = comment("status-3", "2026-11-01T10:02:00Z");
  const reply = comment("reply-to-continuation", "2026-11-01T10:01:00Z");
  const ownComment = comment("own-comment", "2026-11-01T10:03:00Z");
  ownComment.account.acct = "blog@blog.example";
  const rootQuote = comment("root-quote", "2026-11-01T10:04:00Z");
  const threadQuote = comment("thread-quote", "2026-11-01T10:05:00Z");
  const browser = createBrowser({
    post: { id: "status-1", replies: [{ id: "status-2" }, { id: "status-3" }] },
    replies: [firstContinuation, reply, secondContinuation, ownComment],
    quotesByStatus: {
      "status-1": [rootQuote],
      "status-2": [threadQuote, reply],
      "status-3": [threadQuote],
    },
  });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  assert.equal(browser.document.querySelector('[data-count="comments"]').textContent, "4");
  assert.deepEqual(
    Array.from(browser.document.querySelectorAll(".fediverse-reply-content"), (node) => node.textContent),
    ["reply-to-continuation", "own-comment", "root-quote", "thread-quote"],
  );
  const quotePaths = browser.requests.filter(({ url }) => url.pathname.endsWith("/quotes"))
    .map(({ url }) => url.pathname);
  assert.deepEqual(quotePaths, [
    "/api/v1/statuses/status-1/quotes",
    "/api/v1/statuses/status-2/quotes",
    "/api/v1/statuses/status-3/quotes",
  ]);
  assert.deepEqual(browser.errors, []);
});

test("途中の返信結果が未確定なら不正確なコメント数を表示しない", async () => {
  const browser = createBrowser({
    post: { id: "status-1", replies: [{ id: "status-2" }] },
    pendingPaths: [postPath],
    replies: [comment("unconfirmed-continuation", "2026-11-01T10:00:00Z")],
  });
  await waitFor(() => browser.errors.length > 0);

  assert.equal(browser.document.querySelector("[data-fediverse-social]").hidden, false);
  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.equal(browser.document.querySelector("[data-replies]").hidden, true);
  assert.match(String(browser.errors[0][1]), /Thread posting outcome is pending/);
  assert.ok(browser.requests.every(({ url }) => !url.pathname.endsWith("/context")));
});

test("投稿中は未記録の続きがコメントに混ざらないようコメント欄を表示しない", async () => {
  const browser = createBrowser({
    post: { id: "status-1", replies: [{ id: "status-2" }] },
    threads: { [postPath]: { parts: [] } },
    replies: [comment("new-continuation", "2026-11-01T10:00:00Z")],
  });
  await waitFor(() => browser.requests.some(({ url }) => url.pathname === statusPath));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.ok(browser.requests.every(({ url }) => !url.pathname.endsWith("/context")));
  const mappingRequest = browser.requests.find(({ url }) => url.pathname === "/fediverse/posts.json");
  assert.equal(mappingRequest.init.cache, "no-store");
  assert.deepEqual(browser.errors, []);
});

test("続きの投稿の引用を取得できない場合も不完全なコメント数を表示しない", async () => {
  const browser = createBrowser({
    post: { id: "status-1", replies: [{ id: "status-2" }] },
    quoteResponse(url) {
      return url.pathname.includes("/status-2/")
        ? new Response("", { status: 503 })
        : Response.json([]);
    },
  });
  await waitFor(() => browser.errors.length > 0);

  assert.equal(browser.document.querySelector("[data-fediverse-social]").hidden, false);
  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.equal(browser.errors[0][0], "Failed to load Fediverse comments");
  assert.match(String(browser.errors[0][1]), /HTTP 503/);
});

test("続きの投稿 ID が重複している場合はコメント欄を表示しない", async () => {
  const browser = createBrowser({
    post: { id: "status-1", replies: [{ id: "status-2" }, { id: "status-2" }] },
  });
  await waitFor(() => browser.errors.length > 0);

  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.match(String(browser.errors[0][1]), /Duplicate thread status IDs/);
});

test("返信がなくても引用をコメントとして表示する", async () => {
  const browser = createBrowser({
    quotes: [comment("quote-only", "2026-11-01T10:00:00Z")],
  });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  assert.equal(browser.document.querySelector('[data-count="comments"]').textContent, "1");
  assert.equal(browser.document.querySelectorAll(".fediverse-reply").length, 1);
  assert.equal(browser.document.querySelector("[data-no-replies]").hidden, true);
  assert.deepEqual(browser.errors, []);
});

test("引用がなくても返信をコメントとして表示し、空のリアクション一覧は隠す", async () => {
  const browser = createBrowser({
    replies: [comment("reply-only", "2026-11-01T10:00:00Z")],
    reactions: [],
    mediaProxyUrl: "",
  });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  assert.equal(browser.document.querySelector('[data-count="comments"]').textContent, "1");
  assert.equal(browser.document.querySelector('[data-count="emoji_reactions"]').textContent, "0");
  assert.equal(browser.document.querySelector("[data-reactions]").hidden, true);
  assert.equal(
    browser.document.querySelector(".fediverse-reply-avatar").getAttribute("src"),
    "https://remote.example/avatar/reply-only.png",
  );
  assert.deepEqual(browser.errors, []);
});

test("投稿者の名前がないコメントは日本語で不明と表示する", async () => {
  const anonymousQuote = comment("anonymous", "2026-11-01T10:00:00Z");
  anonymousQuote.account = {};
  const browser = createBrowser({ quotes: [anonymousQuote] });
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  assert.equal(browser.document.querySelector(".fediverse-reply-author").textContent, "不明なユーザー");
  assert.deepEqual(browser.errors, []);
});

test("返信と引用がどちらもない場合はコメント数0と空の案内を表示する", async () => {
  const browser = createBrowser();
  await waitFor(() => !browser.document.querySelector("[data-comment-count]").hidden);

  assert.equal(browser.document.querySelector('[data-count="comments"]').textContent, "0");
  assert.equal(browser.document.querySelector("[data-no-replies]").hidden, false);
  assert.equal(browser.document.querySelectorAll(".fediverse-reply").length, 0);
  assert.deepEqual(browser.errors, []);
});

for (const failingSource of ["quoteError", "contextError"]) {
  test(`${failingSource}では不完全なコメント数を表示せず他の数値を残す`, async () => {
    const browser = createBrowser({ [failingSource]: true });
    await waitFor(() => browser.errors.length > 0);

    assert.equal(browser.document.querySelector("[data-fediverse-social]").hidden, false);
    assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
    assert.equal(browser.document.querySelector("[data-replies]").hidden, true);
    assert.equal(browser.document.querySelector('[data-count="favourites_count"]').textContent, "2");
    assert.equal(browser.errors[0][0], "Failed to load Fediverse comments");
    assert.match(String(browser.errors[0][1]), /HTTP 503/);
  });
}

test("引用のページ送りが同じカーソルを返したら停止してエラーを出す", async () => {
  const browser = createBrowser({
    quoteResponse() {
      return Response.json([], {
        headers: {
          Link: `<${origin}${statusPath}/quotes?max_id=repeated>; rel="next"`,
        },
      });
    },
  });
  await waitFor(() => browser.errors.length > 0);

  assert.equal(browser.requests.filter(({ url }) => url.pathname === `${statusPath}/quotes`).length, 2);
  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.match(String(browser.errors[0][1]), /repeated cursor/);
});

test("未投稿記事ではHolloの反応を取得せず閲覧数だけを表示する", async () => {
  const browser = createBrowser({ unpublished: true });
  await waitFor(() => !browser.document.querySelector("[data-view-count]").hidden);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(browser.document.querySelector("[data-fediverse-social]").hidden, true);
  assert.equal(browser.document.querySelector("[data-comment-count]").hidden, true);
  assert.equal(browser.document.querySelector("[data-view-count-value]").textContent, "12");
  assert.ok(browser.requests.every(({ url }) => !url.pathname.startsWith(statusPath)));
  assert.deepEqual(browser.errors, []);
});

test("GoatCounterの計測先は現在のオリジンを使い、ローカル計測を有効にしない", () => {
  const document = domino.createDocument(`<html><head>${headTemplate}</head></html>`);
  const counter = document.querySelector("script[data-goatcounter]");

  assert.equal(counter.getAttribute("data-goatcounter"), "/gc/count");
  assert.equal(counter.getAttribute("src"), "/gc/count.js");
  assert.equal(counter.getAttribute("data-goatcounter-settings"), null);
});

for (const [value, expected] of [
  ["1\u202f234", "1,234"],
  ["1\u00a0234\u00a0567", "1,234,567"],
  ["1,234,567", "1,234,567"],
  ["12.345", "12,345"],
  ["9007199254740993", "9,007,199,254,740,993"],
  [42, "42"],
]) {
  test(`GoatCounterの閲覧数 ${JSON.stringify(value)} を表示する`, async () => {
    const browser = createBrowser({ viewResponse: () => Response.json({ count: value }) });
    await waitFor(() => !browser.document.querySelector("[data-view-count]").hidden);

    assert.equal(browser.document.querySelector("[data-view-count-value]").textContent, expected);
    assert.equal(browser.document.querySelector("[data-view-count-unavailable]").hidden, true);
    assert.deepEqual(browser.errors, []);
  });
}

test("GoatCounterが未計測ページの404とゼロを返す場合は閲覧数0を表示する", async () => {
  const browser = createBrowser({
    viewResponse: () => new Response('{"count_unique":"0","count":"0"}', { status: 404 }),
  });
  await waitFor(() => !browser.document.querySelector("[data-view-count]").hidden);

  assert.equal(browser.document.querySelector("[data-view-count-value]").textContent, "0");
  assert.equal(browser.document.querySelector("[data-view-count-unavailable]").hidden, true);
  assert.deepEqual(browser.errors, []);
});

for (const [name, viewResponse, message] of [
  [
    "閲覧数の公開設定が無効な403",
    () => new Response("", { status: 403 }),
    /HTTP 403/,
  ],
  [
    "別の404応答",
    () => Response.json({ count: "0", count_unique: "1" }, { status: 404 }),
    /HTTP 404/,
  ],
  [
    "HTMLの404応答",
    () => new Response("<h1>Not found</h1>", { status: 404 }),
    /Invalid GoatCounter JSON response \(HTTP 404\)/,
  ],
  [
    "サーバーエラー",
    () => new Response("", { status: 500 }),
    /HTTP 500/,
  ],
  [
    "サイト未作成時のリダイレクト",
    () => {
      const response = new Response("<html></html>");
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
    /Unexpected GoatCounter redirect/,
  ],
  ...["", "1.23", "-3", "12e3", "1,234.567"].map((value) => [
    `不正な閲覧数 ${JSON.stringify(value)}`,
    () => Response.json({ count: value }),
    /Invalid GoatCounter pageview count/,
  ]),
]) {
  test(`${name}は閲覧数0を仮表示して英語のエラーを出す`, async () => {
    const browser = createBrowser({ viewResponse });
    await waitFor(() => browser.errors.some(([text]) => text === "Failed to load GoatCounter pageview count"));
    await waitFor(() => !browser.document.querySelector("[data-fediverse-social]").hidden);

    const error = browser.errors.find(([text]) => text === "Failed to load GoatCounter pageview count");
    assert.match(String(error[1]), message);
    assert.equal(browser.document.querySelector("[data-view-count]").hidden, false);
    assert.equal(browser.document.querySelector("[data-view-count-value]").textContent, "0");
    const unavailable = browser.document.querySelector("[data-view-count-unavailable]");
    assert.equal(unavailable.hidden, false);
    assert.match(unavailable.getAttribute("aria-label"), /仮表示/);
    assert.equal(browser.document.querySelector('[data-count="favourites_count"]').textContent, "2");
  });
}

test("未投稿記事でも閲覧数を取得できない場合は0を仮表示する", async () => {
  const browser = createBrowser({
    unpublished: true,
    viewResponse: () => new Response("", { status: 403 }),
  });
  await waitFor(() => !browser.document.querySelector("[data-view-count]").hidden);

  assert.equal(browser.panel.hidden, false);
  assert.equal(browser.document.querySelector("[data-view-count-value]").textContent, "0");
  assert.equal(browser.document.querySelector("[data-view-count-unavailable]").hidden, false);
  assert.equal(browser.document.querySelector("[data-fediverse-social]").hidden, true);
  assert.match(String(browser.errors[0][1]), /HTTP 403/);
});

for (const [name, pageUrl, canonicalUrl, expectedPath] of [
  [
    "同じホストのcanonical URL",
    `${origin}${postPath}?ref=local`,
    `${origin}/posts/canonical/?lang=ja`,
    "/posts/canonical/?lang=ja",
  ],
  [
    "wwwの有無だけが異なるcanonical URL",
    `${origin}${postPath}`,
    "https://www.blog.example/posts/canonical/",
    "/posts/canonical/",
  ],
  [
    "別ホストのcanonical URL",
    `${origin}${postPath}?ref=local`,
    "https://other.example/posts/canonical/",
    `${postPath}?ref=local`,
  ],
  [
    "canonical URLなし",
    `${origin}${postPath}?ref=local`,
    undefined,
    `${postPath}?ref=local`,
  ],
]) {
  test(`${name}でもGoatCounterが記録するパスの閲覧数を取得する`, async () => {
    const browser = createBrowser({ pageUrl, canonicalUrl });
    await waitFor(() => !browser.document.querySelector("[data-view-count]").hidden);

    const request = browser.requests.find(({ url }) => url.pathname.startsWith("/gc/counter/"));
    assert.equal(request.url.pathname, `/gc/counter/${encodeURIComponent(expectedPath)}.json`);
    assert.deepEqual(browser.errors, []);
  });
}
