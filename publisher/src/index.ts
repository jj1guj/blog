import { createHash } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createArticleStatus } from "./markdown.ts";

const POLL_INTERVAL_MS = 30_000;

export interface FeedItem {
  path: string;
  title: string;
  contentHtml?: string;
  url: string;
  publishedAt?: string;
}

export interface PublishedPost {
  id: string;
  url: string;
  publishedAt?: string;
}

export interface PostMap {
  version: 1;
  initialized: boolean;
  seenPaths: string[];
  posts: Record<string, PublishedPost>;
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

function normalizeBlogUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BLOG_URL は有効な URL にしてください");
  }
  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BLOG_URL にはホスト名だけを指定してください");
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
    throw new Error("Hugo の RSS が有効な RSS 2.0 形式ではありません");
  }
  if (getElement(xml, "publisher:full-content") !== "1") {
    throw new Error("Hugo の RSS が全文投稿に対応していません。再ビルドを待ってください");
  }
  const baseUrl = normalizeBlogUrl(blogUrl);
  const items: FeedItem[] = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi;
  for (const match of xml.matchAll(itemRegex)) {
    const itemXml = match[1];
    const title = getElement(itemXml, "title")?.trim();
    const link = getElement(itemXml, "link")?.trim();
    if (!title || !link) {
      throw new Error("Hugo の RSS 記事にタイトルまたは URL がありません");
    }

    let articleUrl: URL;
    try {
      articleUrl = new URL(link, baseUrl);
    } catch {
      throw new Error(`RSS 記事の URL が無効です: ${link}`);
    }
    if (!["http:", "https:"].includes(articleUrl.protocol)) {
      throw new Error(`RSS 記事の URL は HTTP または HTTPS にしてください: ${link}`);
    }
    articleUrl.hash = "";
    articleUrl.search = "";
    const canonicalUrl = new URL(articleUrl.pathname, baseUrl);
    const publishedAt = getElement(itemXml, "pubDate")?.trim();
    items.push({
      path: canonicalUrl.pathname,
      title,
      contentHtml: getElement(itemXml, "content:encoded"),
      url: canonicalUrl.href,
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return items;
}

export function createStatusText(item: FeedItem): string {
  if (item.contentHtml === undefined) {
    throw new Error("RSS に記事全文がありません");
  }
  return createArticleStatus(item.title, item.contentHtml, item.url);
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

function parsePostMap(contents: string): PostMap {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("投稿対応表の JSON を読み取れません");
  }
  if (!isRecord(value) || value.version !== 1 ||
      typeof value.initialized !== "boolean" ||
      !Array.isArray(value.seenPaths) ||
      !value.seenPaths.every((path) => typeof path === "string" && path.startsWith("/")) ||
      !isRecord(value.posts)) {
    throw new Error("投稿対応表の形式が正しくありません");
  }
  const posts: Record<string, PublishedPost> = Object.create(null) as Record<
    string,
    PublishedPost
  >;
  for (const [path, rawPost] of Object.entries(value.posts)) {
    if (!path.startsWith("/") || !isRecord(rawPost) ||
        typeof rawPost.id !== "string" || typeof rawPost.url !== "string") {
      throw new Error("投稿対応表に形式が正しくない記事があります");
    }
    posts[path] = {
      id: rawPost.id,
      url: rawPost.url,
      ...(typeof rawPost.publishedAt === "string"
        ? { publishedAt: rawPost.publishedAt }
        : {}),
    };
  }
  return {
    version: 1,
    initialized: value.initialized,
    seenPaths: [...new Set([...value.seenPaths, ...Object.keys(posts)])],
    posts,
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

function getStatusResponse(value: unknown): PublishedPost {
  if (!isRecord(value) || typeof value.id !== "string" ||
      typeof value.url !== "string") {
    throw new Error("Hollo の投稿応答に投稿 ID または URL がありません");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("Hollo の投稿応答に有効な投稿 URL がありません");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Hollo の投稿 URL は HTTP または HTTPS にしてください");
  }
  return {
    id: value.id,
    url: url.href,
    ...(typeof value.created_at === "string"
      ? { publishedAt: value.created_at }
      : {}),
  };
}

async function getStatusCharacterLimit(options: PublisherOptions): Promise<number> {
  const endpoint = new URL("/api/v2/instance", options.holloApiUrl);
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    headers: forwardedHeaders(options.blogUrl),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Hollo の投稿文字数上限を取得できません: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Hollo のインスタンス情報を JSON として読み取れません");
  }
  if (!isRecord(body) || !isRecord(body.configuration) ||
      !isRecord(body.configuration.statuses) ||
      typeof body.configuration.statuses.max_characters !== "number" ||
      !Number.isSafeInteger(body.configuration.statuses.max_characters) ||
      body.configuration.statuses.max_characters <= 0) {
    throw new Error("Hollo の投稿文字数上限が不正です");
  }
  return body.configuration.statuses.max_characters;
}

async function createStatus(
  item: FeedItem,
  status: string,
  options: PublisherOptions,
): Promise<PublishedPost> {
  const endpoint = new URL("/api/v1/statuses", options.holloApiUrl);
  const idempotencyKey = createHash("sha256").update(item.path).digest("hex");
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      ...forwardedHeaders(options.blogUrl),
      Authorization: `Bearer ${options.accessToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      status,
      visibility: "public",
      language: "ja",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Hollo への投稿に失敗しました: HTTP ${response.status}`);
  }
  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new Error("Hollo の投稿応答を JSON として読み取れません");
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
  const newItems = orderedByDate(items).filter((item) => !seenPaths.has(item.path));

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
  if (newItems.length === 0) return { baselineSkipped: 0, published: 0 };

  const characterLimit = await getStatusCharacterLimit(options);
  let published = 0;
  const failures: string[] = [];
  for (const item of newItems) {
    if (seenPaths.has(item.path)) continue;
    let post: PublishedPost;
    try {
      const status = createStatusText(item);
      const length = Array.from(status).length;
      if (length > characterLimit) {
        throw new Error(`投稿本文は ${length} 文字です（Hollo の公称上限は ${characterLimit} 文字）`);
      }
      post = await createStatus(item, status, options);
    } catch (error) {
      failures.push(`${item.path}: ${errorMessage(error)}`);
      continue;
    }
    postMap.seenPaths.push(item.path);
    postMap.posts[item.path] = post;
    await savePostMap(options.mapPath, postMap);
    seenPaths.add(item.path);
    published++;
  }
  if (failures.length > 0) {
    throw new Error(`記事 ${failures.length} 件の投稿に失敗しました:\n${failures.join("\n")}`);
  }
  return { baselineSkipped: 0, published };
}

function parseBoolean(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${name} は true または false にしてください`);
}

function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HOLLO_API_URL は有効な URL にしてください");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("HOLLO_API_URL には HTTP または HTTPS の URL を指定してください");
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
    console.info("[publisher] 自動投稿は無効です");
  } else if (!config.accessToken) {
    console.error(
      "[publisher] HOLLO_ACCESS_TOKEN が未設定のため投稿を待機します。トークンを設定して publisher を再起動してください",
    );
  } else {
    console.info("[publisher] Hugo RSS の監視を開始しました");
  }

  while (true) {
    if (config.enabled && config.accessToken) {
      try {
        const result = await publishNewItems(config);
        if (result.baselineSkipped > 0) {
          console.info(
            `[publisher] 初回起動時の記事 ${result.baselineSkipped} 件を投稿せず記録しました`,
          );
        }
        if (result.published > 0) {
          console.info(`[publisher] 新しい記事を ${result.published} 件投稿しました`);
        }
      } catch (error) {
        console.error(`[publisher] 投稿処理に失敗しました: ${errorMessage(error)}`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[publisher] 起動に失敗しました: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
