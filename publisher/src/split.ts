import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Root } from "mdast";

import type { ArticleImage, ArticleMarkdown, MarkdownRange } from "./markdown.ts";

export interface StatusPart {
  status: string;
  images: ArticleImage[];
}

interface LocatedImage {
  offset: number;
  image: ArticleImage;
}

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

function characterOffsets(value: string): number[] {
  const offsets = [0];
  for (const character of value) {
    offsets.push(offsets[offsets.length - 1] + character.length);
  }
  return offsets;
}

function graphemeOffsets(value: string): Set<number> {
  const offsets = new Set<number>();
  for (const segment of segmenter.segment(value)) offsets.add(segment.index);
  offsets.add(value.length);
  return offsets;
}

function rangeOf(node: Nodes): MarkdownRange {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error("Markdown parser did not return source positions");
  }
  return { start, end };
}

function maskedMarkdown(article: ArticleMarkdown): string {
  const ranges = [...article.mathRanges].sort((a, b) => a.start - b.start);
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    if (range.start < offset || range.end < range.start || range.end > article.status.length) {
      throw new Error("Invalid math range in Markdown");
    }
    result += article.status.slice(offset, range.start);
    result += article.status.slice(range.start, range.end).replace(/[^\r\n]/g, "x");
    offset = range.end;
  }
  return result + article.status.slice(offset);
}

function parseMarkdown(article: ArticleMarkdown): Root {
  return fromMarkdown(maskedMarkdown(article), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

function splitFencedCode(raw: string, limit: number): string {
  const headerEnd = raw.indexOf("\n");
  const match = raw.slice(0, headerEnd).match(/^(`{3,})([^`]*)$/);
  if (headerEnd < 0 || !match || !raw.endsWith(`\n${match[1]}`)) {
    throw new Error("Cannot split an oversized code block safely");
  }
  const content = raw.slice(headerEnd + 1, -match[1].length - 1);
  const longest = Array.from(content.matchAll(/`{3,}/g))
    .reduce((maximum, result) => Math.max(maximum, result[0].length), 2);
  const fence = "`".repeat(Math.max(match[1].length, longest + 1));
  const header = `${fence}${match[2]}`;
  const capacity = limit - Array.from(`${header}\n\n${fence}`).length;
  if (capacity <= 0) throw new Error("Code block fence exceeds the Hollo character limit");

  const offsets = characterOffsets(content);
  const graphemes = graphemeOffsets(content);
  const blocks: string[] = [];
  let start = 0;
  while (start < offsets.length - 1) {
    let end = Math.min(start + capacity, offsets.length - 1);
    while (end > start && !graphemes.has(offsets[end])) end--;
    if (end === start) throw new Error("A code block character exceeds the Hollo character limit");
    if (end < offsets.length - 1) {
      const minimum = start + Math.floor((end - start) / 2);
      for (let index = end; index > minimum; index--) {
        if (content.slice(offsets[index - 1], offsets[index]) === "\n") {
          end = index;
          break;
        }
      }
    }
    const body = content.slice(offsets[start], offsets[end]);
    blocks.push(`${header}\n${body}\n${fence}`);
    start = end;
  }
  return blocks.join("\n\n");
}

function splitTable(raw: string, limit: number): string {
  const firstLine = raw.indexOf("\n");
  const secondLine = raw.indexOf("\n", firstLine + 1);
  if (firstLine < 0 || secondLine < 0) {
    throw new Error("Cannot split an oversized table safely");
  }
  const header = raw.slice(0, secondLine);
  const rows = raw.slice(secondLine + 1).split("\n");
  const tables: string[] = [];
  let table = header;
  for (const row of rows) {
    const next = `${table}\n${row}`;
    if (Array.from(next).length > limit) {
      if (table === header) throw new Error("A table row exceeds the Hollo character limit");
      tables.push(table);
      table = `${header}\n${row}`;
      if (Array.from(table).length > limit) {
        throw new Error("A table row exceeds the Hollo character limit");
      }
    } else {
      table = next;
    }
  }
  tables.push(table);
  return tables.join("\n\n");
}

function splitOversizedBlocks(article: ArticleMarkdown, limit: number): ArticleMarkdown {
  const replacements: Array<MarkdownRange & { text: string }> = [];
  for (const node of parseMarkdown(article).children) {
    if (node.type !== "code" && node.type !== "table") continue;
    const range = rangeOf(node);
    const raw = article.status.slice(range.start, range.end);
    if (Array.from(raw).length <= limit) continue;
    if (article.mathRanges.some((math) => math.start < range.end && math.end > range.start)) {
      throw new Error("Cannot split an oversized block containing math safely");
    }
    replacements.push({
      ...range,
      text: node.type === "code" ? splitFencedCode(raw, limit) : splitTable(raw, limit),
    });
  }

  let status = article.status;
  const mathRanges = article.mathRanges.map((range) => ({ ...range }));
  for (const replacement of replacements.reverse()) {
    const delta = replacement.text.length - (replacement.end - replacement.start);
    status = status.slice(0, replacement.start) + replacement.text + status.slice(replacement.end);
    for (const range of mathRanges) {
      if (range.start >= replacement.end) {
        range.start += delta;
        range.end += delta;
      }
    }
  }
  return { status, mathRanges };
}

function imageKey(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid image URL in generated Markdown");
  }
  url.hash = "";
  return url.href;
}

function includeAdjacentDelimiters(status: string, range: MarkdownRange): MarkdownRange {
  let { start, end } = range;
  while (start > 0 && "*_~".includes(status[start - 1])) start--;
  while (end < status.length && "*_~".includes(status[end])) end++;
  return { start, end };
}

function analyzeMarkdown(
  article: ArticleMarkdown,
  images: ArticleImage[],
): { forbidden: Uint8Array; nodeStarts: Set<number>; located: LocatedImage[]; unlocated: ArticleImage[] } {
  const tree = parseMarkdown(article);
  const ranges = article.mathRanges.map((range) => includeAdjacentDelimiters(article.status, range));
  const nodeStarts = new Set<number>();
  const imageByUrl = new Map(images.map((image) => [image.url, image]));
  const located: LocatedImage[] = [];
  const matched = new Set<string>();
  const atomic = new Set([
    "link", "linkReference", "image", "imageReference", "inlineCode",
    "emphasis", "strong", "delete", "html", "break",
  ]);
  const masked = maskedMarkdown(article);

  function visit(node: Nodes): void {
    const range = rangeOf(node);
    if (atomic.has(node.type)) ranges.push(includeAdjacentDelimiters(article.status, range));
    if (node.type === "image") {
      const key = imageKey(node.url);
      const image = imageByUrl.get(key);
      if (image && !matched.has(key)) {
        matched.add(key);
        located.push({ offset: range.start, image });
      }
    }
    if (node.type === "text") {
      const raw = masked.slice(range.start, range.end);
      for (const match of raw.matchAll(/(?:https?:\/\/|ftp:\/\/|mailto:|tel:)[^\s<>"'`]+/giu)) {
        if (match.index !== undefined) {
          ranges.push({
            start: range.start + match.index,
            end: range.start + match.index + match[0].length,
          });
        }
      }
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  }

  for (const node of tree.children) {
    const range = rangeOf(node);
    nodeStarts.add(range.start);
    if (node.type === "list") {
      for (const item of node.children) {
        const itemRange = rangeOf(item);
        nodeStarts.add(itemRange.start);
        ranges.push(itemRange);
      }
    } else if (node.type !== "paragraph") {
      ranges.push(range);
    }
    visit(node);
  }
  for (const match of article.status.matchAll(/\\[\s\S]|&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi)) {
    if (match.index !== undefined) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  const changes = new Int32Array(article.status.length + 1);
  for (const range of ranges) {
    if (range.end - range.start > 1) {
      changes[range.start + 1]++;
      changes[range.end]--;
    }
  }
  const forbidden = new Uint8Array(article.status.length + 1);
  let active = 0;
  for (let index = 0; index < forbidden.length; index++) {
    active += changes[index];
    if (active > 0) forbidden[index] = 1;
  }
  located.sort((left, right) => left.offset - right.offset);
  return {
    forbidden,
    nodeStarts,
    located,
    unlocated: images.filter((image) => !matched.has(image.url)),
  };
}

function startsNewMarkdownBlock(status: string, offset: number): boolean {
  const next = status.slice(offset, offset + 256);
  return /^[ \t]*(?:(?:#{1,6}|[-+*>])(?:[ \t]|$)|\d{1,9}[.)][ \t]|`{3,}|~{3,}|\[[^\]\n]+\]:)/.test(next);
}

function chooseBoundary(
  status: string,
  offsets: number[],
  start: number,
  target: number,
  forbidden: Uint8Array,
  graphemes: Set<number>,
  nodeStarts: Set<number>,
): number | undefined {
  let last: number | undefined;
  let line: number | undefined;
  let word: number | undefined;
  const minimum = start + Math.floor((target - start) * 0.7);
  const contentStart = status.slice(offsets[start]).search(/\S/u);
  for (let index = target; index > start; index--) {
    const offset = offsets[index];
    if (forbidden[offset] || !graphemes.has(offset) ||
      (!nodeStarts.has(offset) && startsNewMarkdownBlock(status, offset)) ||
      contentStart < 0 || offset <= offsets[start] + contentStart) {
      continue;
    }
    last ??= index;
    if (index < minimum) continue;
    const before = status.slice(Math.max(0, offset - 2), offset);
    if (before === "\n\n") return index;
    if (line === undefined && before.endsWith("\n")) line = index;
    if (word === undefined && /[\s。！？.!?]$/u.test(before)) word = index;
  }
  return line ?? word ?? last;
}

export function splitArticleStatus(
  original: ArticleMarkdown,
  images: ArticleImage[],
  characterLimit: number,
  mediaLimit: number,
): StatusPart[] {
  if (!Number.isSafeInteger(characterLimit) || characterLimit <= 0) {
    throw new Error("Hollo character limit is invalid");
  }
  if (!Number.isSafeInteger(mediaLimit) || mediaLimit < 0) {
    throw new Error("Hollo media attachment limit is invalid");
  }
  if (images.length > 0 && (!Number.isSafeInteger(mediaLimit) || mediaLimit <= 0)) {
    throw new Error("Hollo media attachment limit does not permit images");
  }
  if (Array.from(original.status).length <= characterLimit && images.length <= mediaLimit) {
    return [{ status: original.status, images }];
  }

  const article = splitOversizedBlocks(original, characterLimit);
  const { status } = article;
  const { forbidden, nodeStarts, located, unlocated } = analyzeMarkdown(article, images);
  const offsets = characterOffsets(status);
  const graphemes = graphemeOffsets(status);
  const parts: StatusPart[] = [];
  let start = 0;
  let imageIndex = 0;

  while (start < offsets.length - 1) {
    if (!status.slice(offsets[start]).trim()) break;
    const maximum = Math.min(start + characterLimit, offsets.length - 1);
    let target = maximum;
    let endImage = imageIndex;
    while (endImage < located.length && located[endImage].offset < offsets[maximum]) endImage++;
    if (endImage - imageIndex > mediaLimit) {
      const cutoff = located[imageIndex + mediaLimit].offset;
      while (target > start && offsets[target] > cutoff) target--;
    }

    let end = target === offsets.length - 1
      ? target
      : chooseBoundary(status, offsets, start, target, forbidden, graphemes, nodeStarts);
    if (end === undefined && target !== maximum) {
      end = maximum === offsets.length - 1
        ? maximum
        : chooseBoundary(status, offsets, start, maximum, forbidden, graphemes, nodeStarts);
    }
    if (end === undefined || end === start) {
      const newlines = status.slice(offsets[start]).match(/^(?:\r?\n)+/)?.[0];
      if (newlines) {
        const nextOffset = offsets[start] + newlines.length;
        while (offsets[start] < nextOffset) start++;
        continue;
      }
      throw new Error("A Markdown construct or link exceeds the Hollo character limit");
    }

    const partImages: ArticleImage[] = [];
    while (imageIndex < located.length && located[imageIndex].offset < offsets[end]) {
      partImages.push(located[imageIndex++].image);
    }
    parts.push({ status: status.slice(offsets[start], offsets[end]), images: partImages.slice(0, mediaLimit) });
    for (let index = mediaLimit; index < partImages.length; index += mediaLimit) {
      parts.push({ status: "", images: partImages.slice(index, index + mediaLimit) });
    }
    start = end;
  }

  if (unlocated.length > 0) {
    const last = parts[parts.length - 1];
    const available = mediaLimit - last.images.length;
    last.images.push(...unlocated.slice(0, available));
    for (let index = available; index < unlocated.length; index += mediaLimit) {
      parts.push({ status: "", images: unlocated.slice(index, index + mediaLimit) });
    }
  }
  return parts;
}
