/**
 * Pure takeout parsing/formatting helpers for the LinkedIn data-export feeds
 * (`linkedin.ts`, `linkedin-takeout.ts`).
 *
 * ISOLATE-SAFE BY CONTRACT: this module must never import `node:fs`,
 * `node:path`, or any other builtin the isolate prelude does not provide.
 * Connector bundles run in a V8 isolate and `assertIsolateEligible` rejects the
 * WHOLE bundle over one surviving builtin `require`, so an `fs` import here
 * would take down the live browser feeds of every connector that shares these
 * helpers — the LinkedIn regression in Lobu#3392.
 *
 * `node:crypto` is fine: the guest prelude serves it from `global.crypto`
 * (see ISOLATE_PRELUDE_PROVIDED_BUILTINS).
 *
 * The CSV reader is injected into the connector (see its constructor), never
 * imported, so no filesystem code reaches the bundle.
 */

import { createHash } from "node:crypto";
import type { EventEnvelope } from "@lobu/connector-sdk";

const DEFAULT_WATERMARK = "1970-01-01T00:00:00.000Z";
const DEFAULT_BATCH_SIZE = 1000;

export interface LocalTakeoutConfig {
  takeout_dir?: string;
  batch_size?: number;
}

export function batchSize(config: LocalTakeoutConfig): number {
  return Math.max(1, Math.min(config.batch_size ?? DEFAULT_BATCH_SIZE, 5000));
}

export function takeBatch<T extends EventEnvelope>(
  events: T[],
  watermark: string | undefined,
  max: number
): T[] {
  const after = watermark ?? DEFAULT_WATERMARK;
  return events
    .filter((event) => eventCursor(event) > after)
    .sort((a, b) => eventCursor(a).localeCompare(eventCursor(b)))
    .slice(0, max);
}

export function maxEventCursor(
  events: EventEnvelope[],
  fallback?: string
): string {
  return events.reduce(
    (max, event) => (eventCursor(event) > max ? eventCursor(event) : max),
    fallback ?? DEFAULT_WATERMARK
  );
}

// Composite watermark: ISO timestamp + origin_id so events sharing a second
// still order deterministically. The delimiter is persisted inside the jsonb
// checkpoint column, so it must NOT be NUL: Postgres rejects NUL in jsonb
// (unsupported Unicode escape sequence). \u0001 (SOH) sorts before every
// printable char (preserving timestamp-first ordering) and is jsonb-safe.
const CURSOR_DELIMITER = "\u0001";

function eventCursor(event: EventEnvelope): string {
  return `${event.occurred_at.toISOString()}${CURSOR_DELIMITER}${event.origin_id}`;
}

export function stableId(
  prefix: string,
  parts: Array<string | number | undefined>
): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${hash}`;
}

export function stripHtml(html: string): string {
  return decodeHtml(htmlToPlainText(html))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToPlainText(html: string): string {
  let output = "";
  let index = 0;
  const lowerHtml = html.toLowerCase();

  while (index < html.length) {
    const char = html[index];
    if (char !== "<") {
      output += char;
      index += 1;
      continue;
    }

    const tagEnd = html.indexOf(">", index + 1);
    if (tagEnd === -1) {
      output += char;
      index += 1;
      continue;
    }

    const tagName = readTagName(html.slice(index + 1, tagEnd));
    if (tagName === "script" || tagName === "style") {
      const closeTagStart = lowerHtml.indexOf(`</${tagName}`, tagEnd + 1);
      if (closeTagStart === -1) {
        break;
      }
      const closeTagEnd = html.indexOf(">", closeTagStart + tagName.length + 2);
      index = closeTagEnd === -1 ? html.length : closeTagEnd + 1;
      continue;
    }

    if (tagName === "br" || isBlockBreakTag(tagName)) {
      output += "\n";
    }
    index = tagEnd + 1;
  }

  return output;
}

function readTagName(tag: string): string {
  let index = tag[0] === "/" ? 1 : 0;
  while (tag[index] === " " || tag[index] === "\t" || tag[index] === "\n") {
    index += 1;
  }

  let name = "";
  while (index < tag.length) {
    const char = tag[index]?.toLowerCase();
    if (!char || !isAsciiNameChar(char)) {
      break;
    }
    name += char;
    index += 1;
  }
  return name;
}

function isAsciiNameChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-"
  );
}

function isBlockBreakTag(tagName: string): boolean {
  return (
    tagName === "p" ||
    tagName === "div" ||
    tagName === "li" ||
    tagName === "h1" ||
    tagName === "h2" ||
    tagName === "h3" ||
    tagName === "h4" ||
    tagName === "h5" ||
    tagName === "h6"
  );
}

export function decodeHtml(text: string): string {
  return text.replace(
    /&(nbsp|amp|quot|#039|apos|#\d+|#x[0-9a-f]+);/gi,
    (entity, code) => {
      const normalized = String(code).toLowerCase();
      if (normalized === "nbsp") return " ";
      if (normalized === "amp") return "&";
      if (normalized === "quot") return '"';
      if (normalized === "#039" || normalized === "apos") return "'";
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return decodeHtmlCodePoint(codePoint, entity);
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number(normalized.slice(1));
        return decodeHtmlCodePoint(codePoint, entity);
      }
      return entity;
    }
  );
}

function decodeHtmlCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  if (codePoint === 60 || codePoint === 62) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);

  const headerIndex = rows.findIndex((candidate) => {
    const values = candidate.map((value) => value.trim()).filter(Boolean);
    return values.length > 1 && !values[0]?.startsWith("Notes:");
  });
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex].map((value) => value.trim());
  return rows.slice(headerIndex + 1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = values[index]?.trim() ?? "";
    });
    return record;
  });
}
