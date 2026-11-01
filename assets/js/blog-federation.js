const socialPanel = document.querySelector("[data-fediverse-stats]");
const commentPanel = document.querySelector("[data-replies]");
const numberFormat = new Intl.NumberFormat("ja-JP");
const allowedReplyTags = new Set([
  "p", "br", "a", "span", "strong", "em", "code", "pre", "blockquote",
  "ul", "ol", "li",
]);
const discardReplyTags = new Set(["script", "style", "iframe", "object", "embed", "svg", "math"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function requiredCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} count in Hollo response`);
  }
  return value;
}

async function fetchResponse(url, { allowNotFound = false } = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response;
}

async function fetchJson(url) {
  return (await fetchResponse(url)).json();
}

function getMediaProxyUrl(value, kind) {
  const source = httpUrl(value);
  if (!source) return null;
  const configured = socialPanel.dataset.mediaProxyUrl.trim();
  if (!configured) return source.href;

  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("MEDIA_PROXY_URL is not a valid URL");
  }
  if (base.protocol !== "https:" || base.username || base.password ||
      base.search || base.hash) {
    throw new Error("MEDIA_PROXY_URL must be an HTTPS origin or path");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const proxied = new URL("image.webp", base);
  proxied.searchParams.set("url", source.href);
  proxied.searchParams.set(kind, "1");
  return proxied.href;
}

function appendSanitizedNodes(source, target) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent ?? ""));
      continue;
    }
    if (!(node instanceof Element)) continue;

    const tag = node.tagName.toLowerCase();
    if (discardReplyTags.has(tag)) continue;
    if (!allowedReplyTags.has(tag)) {
      appendSanitizedNodes(node, target);
      continue;
    }

    let safeTag = tag;
    const href = tag === "a" ? httpUrl(node.getAttribute("href")) : null;
    if (tag === "a" && !href) safeTag = "span";
    const clean = document.createElement(safeTag);
    if (safeTag === "a" && href) {
      clean.href = href.href;
      clean.rel = "nofollow noopener noreferrer";
    }
    appendSanitizedNodes(node, clean);
    target.append(clean);
  }
}

function sanitizeReplyHtml(html) {
  const source = new DOMParser().parseFromString(html, "text/html");
  const safe = document.createDocumentFragment();
  appendSanitizedNodes(source.body, safe);
  return safe;
}

function makeProfileLink(account) {
  const link = document.createElement("a");
  link.className = "fediverse-profile";
  link.href = new URL("/@blog", location.origin).href;
  link.textContent = `@blog@${location.host}`;

  const count = document.createElement("span");
  count.className = "fediverse-profile-count";
  count.textContent = ` · フォロワー ${numberFormat.format(requiredCount(account.followers_count, "followers"))}`;
  link.append(count);

  const menu = document.querySelector("#menu");
  if (!menu) throw new Error("Could not find the site navigation menu");
  const item = document.createElement("li");
  item.append(link);
  menu.append(item);
}

async function loadFollowers() {
  const accountUrl = new URL("/api/v1/accounts/lookup", location.origin);
  accountUrl.searchParams.set("acct", `blog@${location.host}`);
  const account = await fetchJson(accountUrl);
  if (!isRecord(account)) throw new Error("Invalid Hollo account response");
  makeProfileLink(account);
}

function renderReactions(reactions) {
  if (!Array.isArray(reactions)) throw new Error("Invalid emoji reactions in Hollo response");
  const list = socialPanel.querySelector("[data-reactions]");

  let totalCount = 0;
  for (const reaction of reactions) {
    if (!isRecord(reaction) || typeof reaction.name !== "string") {
      throw new Error("Invalid emoji reaction in Hollo response");
    }
    const count = requiredCount(reaction.count, "emoji reaction");
    totalCount += count;
    requiredCount(totalCount, "total emoji reaction");
    const item = document.createElement("li");
    const imageUrl = getMediaProxyUrl(reaction.static_url ?? reaction.url, "emoji");
    if (imageUrl) {
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = `:${reaction.name}:`;
      image.title = image.alt;
      image.loading = "lazy";
      image.onerror = () => {
        console.error("Failed to load reaction emoji image", imageUrl);
        image.replaceWith(document.createTextNode(image.alt));
      };
      item.append(image);
    } else {
      item.append(document.createTextNode(reaction.name));
    }
    const total = document.createElement("span");
    total.textContent = numberFormat.format(count);
    item.append(total);
    list.append(item);
  }
  if (reactions.length > 0) list.hidden = false;
  return totalCount;
}

function renderSocialStatus(status) {
  const social = socialPanel.querySelector("[data-fediverse-social]");
  const postUrl = httpUrl(status.url);
  if (!postUrl) throw new Error("Invalid Hollo status URL");

  for (const name of ["favourites_count", "reblogs_count"]) {
    const value = socialPanel.querySelector(`[data-count="${name}"]`);
    value.textContent = numberFormat.format(requiredCount(status[name], name));
  }

  const reactionCount = renderReactions(status.emoji_reactions);
  socialPanel.querySelector('[data-count="emoji_reactions"]').textContent =
    numberFormat.format(reactionCount);
  const link = social.querySelector("[data-status-link]");
  link.href = postUrl.href;
  link.rel = "noopener noreferrer";

  const alternate = document.createElement("link");
  alternate.rel = "alternate";
  alternate.type = "application/activity+json";
  alternate.href = postUrl.href;
  document.head.querySelector('link[rel="alternate"][type="application/activity+json"]')?.remove();
  document.head.append(alternate);
  socialPanel.querySelectorAll("[data-fediverse-count]").forEach((item) => {
    item.hidden = false;
  });
  social.hidden = false;
}

function renderReply(reply) {
  if (!isRecord(reply) || !isRecord(reply.account) || typeof reply.content !== "string") {
    throw new Error("Invalid reply in Hollo context response");
  }
  const item = document.createElement("li");
  item.className = "fediverse-reply";
  const header = document.createElement("div");
  header.className = "fediverse-reply-header";

  const avatarUrl = getMediaProxyUrl(reply.account.avatar, "avatar");
  if (avatarUrl) {
    const avatar = document.createElement("img");
    avatar.className = "fediverse-reply-avatar";
    avatar.src = avatarUrl;
    avatar.alt = "";
    avatar.loading = "lazy";
    avatar.onerror = () => {
      console.error("Failed to load reply avatar", avatarUrl);
      avatar.remove();
    };
    header.append(avatar);
  }

  const author = document.createElement("div");
  const accountUrl = httpUrl(reply.account.url);
  const name = typeof reply.account.display_name === "string" && reply.account.display_name.trim()
    ? reply.account.display_name
    : reply.account.acct || reply.account.username || "不明なユーザー";
  const authorLabel = document.createElement(accountUrl ? "a" : "span");
  authorLabel.className = "fediverse-reply-author";
  authorLabel.textContent = name;
  if (accountUrl) {
    authorLabel.href = accountUrl.href;
    authorLabel.rel = "noopener noreferrer";
  }
  author.append(authorLabel);
  if (typeof reply.account.acct === "string" && reply.account.acct) {
    const handle = document.createElement("div");
    handle.className = "fediverse-reply-acct";
    handle.textContent = `@${reply.account.acct}`;
    author.append(handle);
  }
  header.append(author);
  item.append(header);

  const content = document.createElement("div");
  content.className = "fediverse-reply-content";
  content.append(sanitizeReplyHtml(reply.content));
  item.append(content);

  const meta = document.createElement("div");
  meta.className = "fediverse-reply-meta";
  if (typeof reply.created_at === "string" && Number.isFinite(Date.parse(reply.created_at))) {
    const time = document.createElement("time");
    time.dateTime = reply.created_at;
    time.textContent = new Date(reply.created_at).toLocaleString("ja-JP");
    meta.append(time);
  }
  const replyUrl = httpUrl(reply.url);
  if (replyUrl) {
    if (meta.childNodes.length) meta.append(document.createTextNode(" · "));
    const link = document.createElement("a");
    link.href = replyUrl.href;
    link.rel = "noopener noreferrer";
    link.textContent = "元の投稿";
    meta.append(link);
  }
  if (meta.childNodes.length) item.append(meta);
  return item;
}

async function fetchQuotes(statusId) {
  const endpoint = new URL(
    `/api/v1/statuses/${encodeURIComponent(statusId)}/quotes`,
    location.origin,
  );
  endpoint.searchParams.set("limit", "40");
  const quotes = [];
  const cursors = new Set();

  while (true) {
    const response = await fetchResponse(endpoint);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Invalid Hollo quotes response");
    quotes.push(...page);

    const link = response.headers.get("link");
    const next = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!next) break;

    let cursor;
    try {
      cursor = new URL(next[1], location.origin).searchParams.get("max_id");
    } catch {
      throw new Error("Invalid next link in Hollo quotes response");
    }
    if (!cursor || cursors.has(cursor)) {
      throw new Error("Invalid or repeated cursor in Hollo quotes response");
    }
    cursors.add(cursor);
    endpoint.searchParams.set("max_id", cursor);
  }
  return quotes;
}

function mergeComments(replies, quotes) {
  const unique = new Map();
  for (const comment of [...replies, ...quotes]) {
    if (!isRecord(comment) || typeof comment.id !== "string" || !comment.id ||
        typeof comment.created_at !== "string" || !Number.isFinite(Date.parse(comment.created_at))) {
      throw new Error("Invalid comment in Hollo response");
    }
    if (!unique.has(comment.id)) unique.set(comment.id, comment);
  }
  return [...unique.values()].sort(
    (left, right) => Date.parse(left.created_at) - Date.parse(right.created_at),
  );
}

async function loadComments(statusId) {
  const contextUrl = new URL(
    `/api/v1/statuses/${encodeURIComponent(statusId)}/context`,
    location.origin,
  );
  const [context, quotes] = await Promise.all([
    fetchJson(contextUrl),
    fetchQuotes(statusId),
  ]);
  if (!isRecord(context) || !Array.isArray(context.descendants)) {
    throw new Error("Invalid Hollo status context response");
  }
  const comments = mergeComments(context.descendants, quotes);
  const section = commentPanel;
  const list = section.querySelector("[data-reply-list]");
  if (comments.length === 0) {
    section.querySelector("[data-no-replies]").hidden = false;
  } else {
    const fragment = document.createDocumentFragment();
    for (const comment of comments) fragment.append(renderReply(comment));
    list.append(fragment);
  }
  section.querySelector('[data-count="comments"]').textContent =
    numberFormat.format(comments.length);
  section.querySelector("[data-comment-count]").hidden = false;
  section.hidden = false;
}

function goatcounterPath() {
  let page = location;
  const canonical = document.querySelector('link[rel="canonical"][href]');
  if (canonical) {
    const url = new URL(canonical.href, location.href);
    if (url.hostname.replace(/^www\./, "") === location.hostname.replace(/^www\./, "")) {
      page = url;
    }
  }
  return `${page.pathname}${page.search}` || "/";
}

function formatViewCount(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return numberFormat.format(value);
  }
  if (typeof value !== "string" ||
      !/^(?:\d+|\d{1,3}([^\d])\d{3}(?:\1\d{3})*)$/u.test(value)) {
    throw new Error("Invalid GoatCounter pageview count");
  }
  return numberFormat.format(BigInt(value.replace(/[^\d]/gu, "")));
}

async function loadViewCount() {
  const endpoint = new URL(
    `/gc/counter/${encodeURIComponent(goatcounterPath())}.json`,
    location.origin,
  );
  const response = await fetchResponse(endpoint, { allowNotFound: true });
  if (response.redirected) throw new Error(`Unexpected GoatCounter redirect from ${endpoint}`);
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`Invalid GoatCounter JSON response (HTTP ${response.status})`, { cause: error });
  }
  if (!isRecord(result)) throw new Error("Invalid GoatCounter response");
  if (response.status === 404 && (result.count !== "0" || result.count_unique !== "0")) {
    throw new Error(`HTTP 404 from ${endpoint}`);
  }
  socialPanel.querySelector("[data-view-count-value]").textContent = formatViewCount(result.count);
  socialPanel.querySelector("[data-view-count]").hidden = false;
  socialPanel.hidden = false;
}

async function loadPostMetrics() {
  if (!socialPanel) return;

  const postPath = socialPanel.dataset.postPath;
  try {
    const mapping = await fetchJson(new URL("/fediverse/posts.json", location.origin));
    if (!isRecord(mapping) || !isRecord(mapping.posts)) {
      throw new Error("Invalid Fediverse post map");
    }
    if (!Object.hasOwn(mapping.posts, postPath)) return;
    const post = mapping.posts[postPath];
    if (!isRecord(post) || typeof post.id !== "string" || !post.id) {
      throw new Error("Invalid post in Fediverse post map");
    }

    const statusUrl = new URL(
      `/api/v1/statuses/${encodeURIComponent(post.id)}`,
      location.origin,
    );
    const status = await fetchJson(statusUrl);
    if (!isRecord(status)) throw new Error("Invalid Hollo status response");
    renderSocialStatus(status);
    socialPanel.hidden = false;

    try {
      await loadComments(post.id);
    } catch (error) {
      console.error("Failed to load Fediverse comments", error);
    }
  } catch (error) {
    console.error("Failed to load Fediverse post metrics", error);
  }
}

loadFollowers().catch((error) => {
  console.error("Failed to load Fediverse follower count", error);
});
loadPostMetrics();
if (socialPanel) {
  loadViewCount().catch((error) => {
    console.error("Failed to load GoatCounter pageview count", error);
    socialPanel.querySelector("[data-view-count-value]").textContent = "0";
    socialPanel.querySelector("[data-view-count-unavailable]").hidden = false;
    socialPanel.querySelector("[data-view-count]").hidden = false;
    socialPanel.hidden = false;
  });
}
