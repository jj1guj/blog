import { randomUUID } from "node:crypto";

import { createDocument } from "@mixmark-io/domino";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const UNSUPPORTED_ELEMENTS = "audio, canvas, embed, iframe, math, object, script, style, svg, video";

function extractMath(root: HTMLElement): Map<string, { markdown: string; display: boolean }> {
  const expressions = new Map<string, { markdown: string; display: boolean }>();
  const prefix = `PUBLISHERMATH${randomUUID().replaceAll("-", "")}X`;

  for (const element of Array.from(root.querySelectorAll(".katex-display, .katex"))) {
    if (!root.contains(element)) continue;
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
    if (!annotation || annotation.textContent === null) {
      throw new Error("Cannot extract TeX from math");
    }

    const display = element.classList.contains("katex-display");
    const marker = root.ownerDocument.createElement(display ? "div" : "span");
    const key = `${prefix}${expressions.size}X`;
    const tex = annotation.textContent.trim();
    marker.textContent = key;
    expressions.set(key, {
      markdown: display ? `$$\n${tex}\n$$` : `$${tex}$`,
      display,
    });
    element.parentNode?.replaceChild(marker, element);
  }
  return expressions;
}

function absoluteUrl(value: string, articleUrl: string, image: boolean): string {
  let url: URL;
  try {
    url = new URL(value, articleUrl);
  } catch {
    throw new Error(`Invalid ${image ? "image" : "link"} URL: ${value}`);
  }
  const allowedProtocols = image
    ? ["http:", "https:"]
    : ["http:", "https:", "mailto:", "tel:", "ftp:"];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`Unsupported ${image ? "image" : "link"} URL: ${value}`);
  }
  if (image && (url.username || url.password)) {
    throw new Error("Image URL must not contain credentials");
  }
  return url.href;
}

function imageUrl(image: Element, articleUrl: string): string {
  const src = image.getAttribute("src");
  if (!src?.trim()) throw new Error("Image has no URL");
  return absoluteUrl(src, articleUrl, true);
}

export interface ArticleImage {
  url: string;
  description: string;
}

export interface MarkdownRange {
  start: number;
  end: number;
}

export interface ArticleMarkdown {
  status: string;
  mathRanges: MarkdownRange[];
}

export function extractArticleImages(html: string, articleUrl: string): ArticleImage[] {
  const document = createDocument();
  const root = document.createElement("div");
  root.innerHTML = html;
  const images = new Map<string, ArticleImage>();
  for (const image of Array.from(root.querySelectorAll("img"))) {
    const url = new URL(imageUrl(image, articleUrl));
    url.hash = "";
    if (!images.has(url.href)) {
      images.set(url.href, {
        url: url.href,
        description: image.getAttribute("alt") ?? "",
      });
    }
  }
  return [...images.values()];
}

function prepareArticle(root: HTMLElement, articleUrl: string): void {
  const unsupported = root.querySelector(UNSUPPORTED_ELEMENTS);
  if (unsupported) {
    throw new Error(`Cannot convert <${unsupported.tagName.toLowerCase()}> to Markdown`);
  }

  for (const table of Array.from(root.querySelectorAll("table"))) {
    const row = table.querySelector("tr");
    const cells = row ? Array.from(row.children) : [];
    if (!row || cells.length === 0 ||
        (row.parentElement?.tagName !== "THEAD" &&
          !cells.every((cell) => cell.tagName === "TH"))) {
      throw new Error("Cannot convert a table without a header row to Markdown");
    }
    for (const cell of Array.from(table.querySelectorAll("th, td"))) {
      if (["rowspan", "colspan"].some((name) => {
        const value = cell.getAttribute(name);
        return value !== null && value !== "1";
      })) {
        throw new Error("Cannot convert a table with merged cells to Markdown");
      }
      if (cell.querySelector("blockquote, br, div, figure, hr, ol, p, pre, table, ul")) {
        throw new Error("Cannot convert block elements inside table cells to Markdown");
      }
    }
  }

  for (const link of Array.from(root.querySelectorAll("a[href]"))) {
    if (!link.textContent?.trim() && !link.querySelector("img")) {
      const label = link.getAttribute("aria-label")?.trim();
      if (label) link.textContent = label;
      else {
        link.parentNode?.removeChild(link);
        continue;
      }
    }
    const href = link.getAttribute("href");
    if (href !== null) link.setAttribute("href", absoluteUrl(href, articleUrl, false));
  }
  for (const image of Array.from(root.querySelectorAll("img"))) {
    image.setAttribute("src", imageUrl(image, articleUrl));
  }
}

// Hollo（@fedify/markdown-it-hashtag）がハッシュタグとして認識する文字だけを残す。
export function createHashtags(tags: readonly string[]): string {
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const tag of tags) {
    const name = tag.normalize("NFC").match(/[\w\p{L}]+/gu)?.join("") ?? "";
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    hashtags.push(`#${name}`);
  }
  return hashtags.join(" ");
}

export function createArticleMarkdown(
  title: string,
  html: string,
  articleUrl: string,
  tags: readonly string[] = [],
): ArticleMarkdown {
  const document = createDocument();
  const root = document.createElement("div");
  root.innerHTML = html;
  const expressions = extractMath(root);
  prepareArticle(root, articleUrl);

  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    preformattedCode: true,
  });
  const escape = converter.escape.bind(converter);
  // 既存のエスケープは重ねず、数式や GFM の記号を通常の文字として残す。
  converter.escape = (value) => escape(value.replaceAll("&", "&amp;"))
    .replace(
      /(?<!\\)((?:\\\\)*)([$~<>|])/g,
      (_match, slashes: string, character: string) => `${slashes}\\${character}`,
    );
  converter.use(gfm);
  converter.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const escaped = content.replace(
        /(?<!\\)((?:\\\\)*)\|/g,
        (_match, slashes: string) => `${slashes}\\|`,
      );
      const prefix = node.parentElement?.firstElementChild === node ? "| " : " ";
      return `${prefix}${escaped} |`;
    },
  });
  converter.addRule("strikethrough", {
    filter: (node) => ["DEL", "S", "STRIKE"].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  converter.addRule("image", {
    filter: "img",
    replacement: (_content, node) => {
      const source = node.getAttribute("src");
      if (!source) throw new Error("Image has no URL");
      const alt = converter.escape(node.getAttribute("alt") ?? "");
      const title = node.getAttribute("title");
      const titlePart = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/\s*\n\s*/g, " ")}"`
        : "";
      return `![${alt}](${source.replace(/[\\()<>]/g, "\\$&")}${titlePart})`;
    },
  });
  converter.addRule("codeBlock", {
    filter: "pre",
    replacement: (_content, node) => {
      const code = node.textContent ?? "";
      const codeElement = node.firstElementChild?.tagName === "CODE"
        ? node.firstElementChild
        : null;
      const language = codeElement?.getAttribute("class")
        ?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "";
      if (language.includes("`")) throw new Error("Invalid code block language");
      const longest = Array.from(code.matchAll(/^ {0,3}(`{3,})/gm))
        .reduce((maximum, match) => Math.max(maximum, match[1].length), 2);
      const fence = "`".repeat(longest + 1);
      return `\n\n${fence}${language}\n${code.replace(/\n$/, "")}\n${fence}\n\n`;
    },
  });

  let markdown = converter.turndown(root);
  const mathRanges: MarkdownRange[] = [];
  for (const [key, expression] of expressions) {
    const index = markdown.indexOf(key);
    if (index < 0) throw new Error("Cannot convert math to Markdown");
    const before = markdown.charAt(index - 1);
    const after = markdown.charAt(index + key.length);
    // 隣接する $ や数字で Hollo の数式区切りが誤認されないようにする。
    const prefix = !expression.display && before === "$" ? "\u200b" : "";
    const suffix = !expression.display && /[0-9$]/.test(after) ? "\u200b" : "";
    const replacement = prefix + expression.markdown + suffix;
    const delta = replacement.length - key.length;
    for (const range of mathRanges) {
      if (range.start > index) {
        range.start += delta;
        range.end += delta;
      }
    }
    mathRanges.push({ start: index, end: index + replacement.length });
    markdown = markdown.slice(0, index) + replacement + markdown.slice(index + key.length);
  }
  const introduction = [articleUrl, converter.escape(title.trim())]
    .filter((part) => part.length > 0)
    .join("\n\n");
  const offset = introduction.length + (introduction && markdown ? 2 : 0);
  return {
    status: [introduction, markdown, createHashtags(tags)]
      .filter((part) => part.length > 0)
      .join("\n\n"),
    mathRanges: mathRanges.map((range) => ({
      start: range.start + offset,
      end: range.end + offset,
    })),
  };
}

export function createArticleStatus(
  title: string,
  html: string,
  articleUrl: string,
  tags: readonly string[] = [],
): string {
  return createArticleMarkdown(title, html, articleUrl, tags).status;
}
