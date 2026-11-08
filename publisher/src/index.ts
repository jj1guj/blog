import { createHash } from "node:crypto";
import { readFile, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArticleMarkdown,
  createArticleStatus,
  extractArticleImages,
  type ArticleImage,
} from "./markdown.ts";
import { splitArticleStatus, type StatusPart } from "./split.ts";

const POLL_INTERVAL_MS = 30_000;

export interface FeedItem {
  path: string;
  title: string;
  contentHtml?: string;
  url: string;
  publishedAt?: string;
  tags?: string[];
}

export interface PublishedStatus {
  id: string;
  url: string;
  publishedAt?: string;
}

export interface PublishedPost extends PublishedStatus {
  replies?: PublishedStatus[];
}

export interface ThreadProgress {
  parts: StatusPart[];
}

export interface PostMap {
  version: 1;
  initialized: boolean;
  seenPaths: string[];
  posts: Record<string, PublishedPost>;
  pendingPaths?: string[];
  threads?: Record<string, ThreadProgress>;
}

export interface PublisherOptions {
  feedPath: string;
  mapPath: string;
  blogUrl: string;
  holloApiUrl: string;
  accessToken: string;
  publishExistingOnFirstRun: boolean;
  fetchImpl?: typeof fetch;
}

export interface PublisherConfig extends PublisherOptions {
  enabled: boolean;
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (entity, name: string) => {
      if (name === "amp") return "&";
      if (name === "lt") return "<";
      if (name === "gt") return ">";
      if (name === "quot") return '"';
      if (name === "apos") return "'";
      const codePoint = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 &&
        codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function getElement(xml: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<${escapedName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedName}\\s*>`),
  );
  if (!match) return undefined;
  const value = match[1].trim();
  if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) {
    return value.slice(9, -3);
  }
  return decodeXml(value);
}

function getElements(xml: string, name: string): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${escapedName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escapedName}\\s*>`, "g");
  return Array.from(xml.matchAll(pattern), (match) => getElement(match[0], name) ?? "");
}

function normalizeBlogUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BLOG_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BLOG_URL must contain only a scheme and host");
  }
  return url;
}

function forwardedHeaders(blogUrl: string): Record<string, string> {
  const url = normalizeBlogUrl(blogUrl);
  return {
    "X-Forwarded-Host": url.host,
    "X-Forwarded-Proto": url.protocol.slice(0, -1),
  };
}

export function parseRss(xml: string, blogUrl: string): FeedItem[] {
  if (!/<rss\b[^>]*>/i.test(xml) || !/<channel\b[^>]*>/i.test(xml) ||
    !/<\/channel\s*>/i.test(xml) || !/<\/rss\s*>/i.test(xml)) {
    throw new Error("Hugo RSS is not valid RSS 2.0");
  }
  if (getElement(xml, "publisher:full-content") !== "1") {
    throw new Error("Hugo RSS does not include full content; waiting for rebuild");
  }
  const baseUrl = normalizeBlogUrl(blogUrl);
  const items: FeedItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  for (const match of xml.matchAll(itemRegex)) {
    const itemXml = match[1];
    const title = getElement(itemXml, "title")?.trim();
    const link = getElement(itemXml, "link")?.trim();
    if (!title || !link) {
      throw new Error("Hugo RSS item has no title or URL");
    }

    let articleUrl: URL;
    try {
      articleUrl = new URL(link, baseUrl);
    } catch {
      throw new Error(`Invalid RSS item URL: ${link}`);
    }
    if (!["http:", "https:"].includes(articleUrl.protocol)) {
      throw new Error(`RSS item URL must be HTTP or HTTPS: ${link}`);
    }
    articleUrl.hash = "";
    articleUrl.search = "";
    const canonicalUrl = new URL(articleUrl.pathname, baseUrl);
    const publishedAt = getElement(itemXml, "pubDate")?.trim();
    const tags = getElements(itemXml, "category")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    items.push({
      path: canonicalUrl.pathname,
      title,
      contentHtml: getElement(itemXml, "content:encoded"),
      url: canonicalUrl.href,
      ...(publishedAt ? { publishedAt } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return items;
}

export function createStatusText(item: FeedItem): string {
  if (item.contentHtml === undefined) {
    throw new Error("RSS item has no full content");
  }
  return createArticleStatus(item.title, item.contentHtml, item.url, item.tags);
}

function emptyPostMap(): PostMap {
  return {
    version: 1,
    initialized: false,
    seenPaths: [],
    posts: Object.create(null) as Record<string, PublishedPost>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublishedStatus(value: unknown): PublishedStatus {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
    typeof value.url !== "string" || !value.url) {
    throw new Error("Post map contains an invalid entry");
  }
  return {
    id: value.id,
    url: value.url,
    ...(typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {}),
  };
}

function parseThreadProgress(value: unknown): ThreadProgress {
  if (!isRecord(value) || !Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error("Post map contains an invalid thread");
  }
  const imageUrls = new Set<string>();
  const parts: StatusPart[] = value.parts.map((part: unknown, index: number) => {
    if (!isRecord(part) || typeof part.status !== "string" || !Array.isArray(part.images) ||
      (!part.status.trim() && (index === 0 || part.images.length === 0))) {
      throw new Error("Post map contains an invalid thread part");
    }
    const images: ArticleImage[] = part.images.map((image: unknown) => {
      if (!isRecord(image) || typeof image.url !== "string" ||
        typeof image.description !== "string") {
        throw new Error("Post map contains an invalid thread image");
      }
      let url: URL;
      try {
        url = new URL(image.url);
      } catch {
        throw new Error("Post map contains an invalid thread image URL");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.hash || imageUrls.has(url.href)) {
        throw new Error("Post map contains an invalid or duplicate thread image URL");
      }
      imageUrls.add(url.href);
      return { url: url.href, description: image.description };
    });
    return { status: part.status, images };
  });
  return { parts };
}

function parsePostMap(contents: string): PostMap {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Failed to parse post map JSON");
  }
  if (!isRecord(value) || value.version !== 1 ||
    typeof value.initialized !== "boolean" ||
    !Array.isArray(value.seenPaths) ||
    !value.seenPaths.every((path) => typeof path === "string" && path.startsWith("/")) ||
    (value.pendingPaths !== undefined &&
      (!Array.isArray(value.pendingPaths) ||
        !value.pendingPaths.every((path) => typeof path === "string" && path.startsWith("/")))) ||
    !isRecord(value.posts)) {
    throw new Error("Post map has an invalid format");
  }
  const posts: Record<string, PublishedPost> = Object.create(null) as Record<
    string,
    PublishedPost
  >;
  for (const [path, rawPost] of Object.entries(value.posts)) {
    if (!path.startsWith("/") || !isRecord(rawPost) ||
      (rawPost.replies !== undefined && !Array.isArray(rawPost.replies))) {
      throw new Error("Post map contains an invalid entry");
    }
    const post = parsePublishedStatus(rawPost);
    const replies = Array.isArray(rawPost.replies)
      ? rawPost.replies.map(parsePublishedStatus)
      : undefined;
    const ids = [post.id, ...(replies ?? []).map((reply) => reply.id)];
    if (new Set(ids).size !== ids.length) {
      throw new Error("Post map contains duplicate thread status IDs");
    }
    posts[path] = { ...post, ...(replies ? { replies } : {}) };
  }

  if (value.threads !== undefined && !isRecord(value.threads)) {
    throw new Error("Post map contains invalid threads");
  }
  const threads: Record<string, ThreadProgress> = Object.create(null) as Record<
    string,
    ThreadProgress
  >;
  for (const [path, rawThread] of Object.entries(value.threads ?? {})) {
    if (!path.startsWith("/") || !value.initialized || value.seenPaths.includes(path)) {
      throw new Error("Post map contains an inconsistent thread");
    }
    const thread = parseThreadProgress(rawThread);
    const post = posts[path];
    const posted = post ? 1 + (post.replies?.length ?? 0) : 0;
    if (posted > thread.parts.length ||
      (posted === thread.parts.length &&
        Array.isArray(value.pendingPaths) && value.pendingPaths.includes(path))) {
      throw new Error("Post map contains inconsistent thread progress");
    }
    threads[path] = thread;
  }
  return {
    version: 1,
    initialized: value.initialized,
    seenPaths: [...new Set([
      ...value.seenPaths,
      ...Object.keys(posts).filter((path) => !Object.hasOwn(threads, path)),
    ])],
    posts,
    ...(Array.isArray(value.pendingPaths)
      ? { pendingPaths: [...new Set(value.pendingPaths as string[])] }
      : {}),
    ...(value.threads !== undefined ? { threads } : {}),
  };
}

export async function loadPostMap(filePath: string): Promise<PostMap> {
  try {
    return parsePostMap(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyPostMap();
    throw error;
  }
}

export async function savePostMap(
  filePath: string,
  postMap: PostMap,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(postMap, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function remoteViewDirectory(mapPath: string): string {
  return resolve(dirname(mapPath), "remote-view");
}

// Fediverse の「リモートで表示」で Hollo の投稿ページを開いたとき、記事へ移動させるページ。
// Caddy はブラウザーからの要求にだけ、このファイルを返す。
export function createRemoteViewPage(articleUrl: string): string {
  const href = escapeHtmlAttribute(articleUrl);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${href}">
<link rel="canonical" href="${href}">
<title>記事へ移動します</title>
</head>
<body>
<p><a href="${href}">記事へ移動します</a></p>
</body>
</html>
`;
}

export async function syncRemoteViewPages(
  mapPath: string,
  blogUrl: string,
): Promise<number> {
  const postMap = await loadPostMap(mapPath);
  const directory = remoteViewDirectory(mapPath);
  let written = 0;
  for (const [path, post] of Object.entries(postMap.posts)) {
    for (const status of [post, ...(post.replies ?? [])]) {
      let statusPath: string;
      try {
        statusPath = new URL(status.url).pathname;
      } catch {
        continue;
      }
      if (!/^\/@[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+$/.test(statusPath)) continue;
      const filePath = resolve(directory, `.${statusPath}.html`);
      const content = createRemoteViewPage(new URL(path, blogUrl).href);
      try {
        if (await readFile(filePath, "utf8") === content) continue;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      try {
        await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      written++;
    }
  }
  return written;
}

function getStatusResponse(value: unknown): PublishedStatus {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id ||
    typeof value.url !== "string" || !value.url) {
    throw new Error("Hollo status response has no id or url");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("Hollo status response has an invalid url");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hollo status url must be HTTP or HTTPS");
  }
  return {
    id: value.id,
    url: url.href,
    ...(typeof value.created_at === "string"
      ? { publishedAt: value.created_at }
      : {}),
  };
}

async function getStatusLimits(
  options: PublisherOptions,
): Promise<{ characters: number; mediaAttachments: unknown }> {
  const endpoint = new URL("/api/v2/instance", options.holloApiUrl);
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: forwardedHeaders(options.blogUrl),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to get Hollo character limit: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Failed to parse Hollo instance info as JSON");
  }
  if (!isRecord(body) || !isRecord(body.configuration) ||
    !isRecord(body.configuration.statuses) ||
    typeof body.configuration.statuses.max_characters !== "number" ||
    !Number.isSafeInteger(body.configuration.statuses.max_characters) ||
    body.configuration.statuses.max_characters <= 0) {
    throw new Error("Hollo character limit is invalid");
  }
  return {
    characters: body.configuration.statuses.max_characters,
    mediaAttachments: body.configuration.statuses.max_media_attachments,
  };
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

async function loadImage(image: ArticleImage, options: PublisherOptions): Promise<Blob> {
  const url = new URL(image.url);
  if (url.origin === new URL(options.blogUrl).origin) {
    // 公開 URL が localhost でも取得できるよう、Hugo の共有ボリュームから読む。
    const directory = await realpath(dirname(options.feedPath));
    const filePath = resolve(directory, `.${decodeURIComponent(url.pathname)}`);
    if (!filePath.startsWith(`${directory}${sep}`)) {
      throw new Error("Image path is outside the Hugo public directory");
    }
    const type = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()];
    if (!type) throw new Error("Unsupported local image file extension");
    const resolvedPath = await realpath(filePath);
    if (!resolvedPath.startsWith(`${directory}${sep}`)) {
      throw new Error("Image path is outside the Hugo public directory");
    }
    return new Blob([await readFile(resolvedPath)], { type });
  }
  const response = await (options.fetchImpl ?? fetch)(url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch article image: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error("Article image response has no image content type");
  }
  return blob;
}

async function uploadImages(
  images: ArticleImage[],
  options: PublisherOptions,
): Promise<string[]> {
  const ids: string[] = [];
  for (const image of images) {
    const blob = await loadImage(image, options);
    const form = new FormData();
    form.set("file", blob, basename(new URL(image.url).pathname) || "image");
    form.set("description", image.description);
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/api/v1/media", options.holloApiUrl),
      {
        method: "POST",
        headers: {
          ...forwardedHeaders(options.blogUrl),
          Authorization: `Bearer ${options.accessToken}`,
        },
        body: form,
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to upload image to Hollo: HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Failed to parse Hollo media response as JSON");
    }
    if (!isRecord(body) || typeof body.id !== "string" || !body.id) {
      throw new Error("Hollo media response has no id");
    }
    ids.push(body.id);
  }
  return ids;
}

class RejectedStatusError extends Error { }

async function createStatus(
  path: string,
  index: number,
  status: string,
  mediaIds: string[],
  inReplyToId: string | undefined,
  options: PublisherOptions,
): Promise<PublishedStatus> {
  const endpoint = new URL("/api/v1/statuses", options.holloApiUrl);
  const keySource = index === 0 ? path : `${path}\0${index}`;
  const idempotencyKey = createHash("sha256").update(keySource).digest("hex");
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      ...forwardedHeaders(options.blogUrl),
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      ...(status ? { status } : {}),
      visibility: "public",
      language: "ja",
      ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
      ...(inReplyToId ? { in_reply_to_id: inReplyToId } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const message = `Failed to post to Hollo: HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new RejectedStatusError(message);
    }
    throw new Error(message);
  }
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error("Failed to parse Hollo status response as JSON");
  }
  return getStatusResponse(responseBody);
}

function orderedByDate(items: FeedItem[]): FeedItem[] {
  return [...items].sort((left, right) => {
    const leftDate = left.publishedAt ? Date.parse(left.publishedAt) : Number.NaN;
    const rightDate = right.publishedAt ? Date.parse(right.publishedAt) : Number.NaN;
    if (!Number.isFinite(leftDate) || !Number.isFinite(rightDate)) return 0;
    return leftDate - rightDate;
  });
}

export async function publishNewItems(
  options: PublisherOptions,
): Promise<{ baselineSkipped: number; published: number }> {
  const xml = await readFile(options.feedPath, "utf8");
  const items = parseRss(xml, options.blogUrl);
  const postMap = await loadPostMap(options.mapPath);
  const seenPaths = new Set(postMap.seenPaths);

  if (!postMap.initialized && !options.publishExistingOnFirstRun) {
    postMap.seenPaths = [...new Set([...postMap.seenPaths, ...items.map((item) => item.path)])];
    postMap.initialized = true;
    await savePostMap(options.mapPath, postMap);
    return { baselineSkipped: items.length, published: 0 };
  }

  if (!postMap.initialized) {
    postMap.initialized = true;
    await savePostMap(options.mapPath, postMap);
  }

  const newItems = orderedByDate(items).filter((item) => !seenPaths.has(item.path));
  const presentPaths = new Set(newItems.map((item) => item.path));
  for (const path of Object.keys(postMap.threads ?? {})) {
    if (!seenPaths.has(path) && !presentPaths.has(path)) {
      newItems.push({ path, title: "", url: options.blogUrl });
    }
  }
  if (newItems.length === 0) return { baselineSkipped: 0, published: 0 };

  const limits = await getStatusLimits(options);
  let published = 0;
  const failures: string[] = [];
  const processedPaths = new Set<string>();
  for (const item of newItems) {
    if (seenPaths.has(item.path) || processedPaths.has(item.path)) continue;
    processedPaths.add(item.path);
    if (postMap.pendingPaths?.includes(item.path)) {
      failures.push(`${item.path}: Posting outcome is unknown; automatic retry is blocked. Check Hollo and reconcile the post map before retrying.`);
      continue;
    }

    let parts: StatusPart[];
    let completed = postMap.posts[item.path]
      ? 1 + (postMap.posts[item.path].replies?.length ?? 0)
      : 0;
    try {
      const thread = postMap.threads?.[item.path];
      if (thread) {
        parts = thread.parts;
      } else {
        const html = item.contentHtml;
        if (html === undefined) throw new Error("RSS item has no full content");
        const images = extractArticleImages(html, item.url);
        let mediaLimit = 0;
        if (images.length > 0) {
          if (typeof limits.mediaAttachments !== "number" ||
            !Number.isSafeInteger(limits.mediaAttachments) || limits.mediaAttachments < 0) {
            throw new Error("Hollo media attachment limit is invalid");
          }
          mediaLimit = limits.mediaAttachments;
        }
        parts = splitArticleStatus(
          createArticleMarkdown(item.title, html, item.url, item.tags),
          images,
          limits.characters,
          mediaLimit,
        );
      }

      const remaining = parts.slice(completed);
      if (remaining.some((part) => part.images.length > 0)) {
        if (typeof limits.mediaAttachments !== "number" ||
          !Number.isSafeInteger(limits.mediaAttachments) || limits.mediaAttachments < 0) {
          throw new Error("Hollo media attachment limit is invalid");
        }
        const mediaLimit = limits.mediaAttachments;
        if (remaining.some((part) => part.images.length > mediaLimit)) {
          throw new Error("A saved thread part exceeds the current Hollo media attachment limit");
        }
      }
      if (remaining.some((part) => Array.from(part.status).length > limits.characters)) {
        throw new Error("A saved thread part exceeds the current Hollo character limit");
      }
    } catch (error) {
      failures.push(`${item.path}: ${errorMessage(error)}`);
      continue;
    }

    let failed = false;
    while (completed < parts.length) {
      const part = parts[completed];
      let mediaIds: string[];
      try {
        mediaIds = await uploadImages(part.images, options);
      } catch (error) {
        failures.push(`${item.path}: Part ${completed + 1}/${parts.length}: ${errorMessage(error)}`);
        failed = true;
        break;
      }

      postMap.threads ??= Object.create(null) as Record<string, ThreadProgress>;
      postMap.threads[item.path] = { parts };
      postMap.pendingPaths = [...(postMap.pendingPaths ?? []), item.path];
      await savePostMap(options.mapPath, postMap);

      const root = postMap.posts[item.path];
      const prior = root?.replies?.at(-1) ?? root;
      let status: PublishedStatus;
      try {
        status = await createStatus(item.path, completed, part.status, mediaIds, prior?.id, options);
        if (root && [root, ...(root.replies ?? [])].some((previous) => previous.id === status.id)) {
          throw new Error("Hollo returned an already recorded thread status ID");
        }
      } catch (error) {
        if (error instanceof RejectedStatusError) {
          postMap.pendingPaths = postMap.pendingPaths.filter((path) => path !== item.path);
          if (!root) delete postMap.threads[item.path];
          await savePostMap(options.mapPath, postMap);
        }
        failures.push(`${item.path}: Part ${completed + 1}/${parts.length}: ${errorMessage(error)}`);
        failed = true;
        break;
      }

      if (root) {
        root.replies = [...(root.replies ?? []), status];
      } else {
        postMap.posts[item.path] = status;
      }
      completed++;
      postMap.pendingPaths = postMap.pendingPaths.filter((path) => path !== item.path);
      if (completed === parts.length) {
        delete postMap.threads[item.path];
        postMap.seenPaths.push(item.path);
        seenPaths.add(item.path);
      }
      await savePostMap(options.mapPath, postMap);
      await syncRemoteViewPages(options.mapPath, options.blogUrl);
    }

    if (!failed) {
      if (!seenPaths.has(item.path)) {
        delete postMap.threads?.[item.path];
        postMap.seenPaths.push(item.path);
        seenPaths.add(item.path);
        await savePostMap(options.mapPath, postMap);
        await syncRemoteViewPages(options.mapPath, options.blogUrl);
      }
      published++;
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed to publish ${failures.length} post(s):\n${failures.join("\n")}`);
  }
  return { baselineSkipped: 0, published };
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HOLLO_API_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("HOLLO_API_URL must be an HTTP or HTTPS URL");
  }
  return url.href;
}

export function readConfig(environment: NodeJS.ProcessEnv): PublisherConfig {
  const blogUrl = environment.BLOG_URL?.trim();
  const holloApiUrl = environment.HOLLO_API_URL?.trim();
  return {
    enabled: parseBoolean("PUBLISH_ENABLED", environment.PUBLISH_ENABLED, true),
    publishExistingOnFirstRun: parseBoolean(
      "PUBLISH_EXISTING_ON_FIRST_RUN",
      environment.PUBLISH_EXISTING_ON_FIRST_RUN,
      false,
    ),
    feedPath: environment.HUGO_RSS_PATH?.trim() || "/site/index.xml",
    mapPath: environment.POST_MAP_PATH?.trim() || "/data/posts.json",
    blogUrl: normalizeBlogUrl(blogUrl || "https://example.invalid").href,
    holloApiUrl: normalizeApiUrl(holloApiUrl || "http://hollo:3000"),
    accessToken: environment.HOLLO_ACCESS_TOKEN?.trim() || "",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  if (!config.enabled) {
    console.info("[publisher] Publishing is disabled");
  } else if (!config.accessToken) {
    console.error(
      "[publisher] HOLLO_ACCESS_TOKEN is not set; waiting. Set the token and recreate publisher",
    );
  } else {
    console.info("[publisher] Watching Hugo RSS");
  }

  while (true) {
    try {
      await syncRemoteViewPages(config.mapPath, config.blogUrl);
    } catch (error) {
      console.error(`[publisher] Failed to write remote view pages: ${errorMessage(error)}`);
    }
    if (config.enabled && config.accessToken) {
      try {
        const result = await publishNewItems(config);
        if (result.baselineSkipped > 0) {
          console.info(
            `[publisher] Recorded ${result.baselineSkipped} existing post(s) without publishing`,
          );
        }
        if (result.published > 0) {
          console.info(`[publisher] Published ${result.published} new post(s)`);
        }
      } catch (error) {
        console.error(`[publisher] Publishing failed: ${errorMessage(error)}`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[publisher] Startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
