/**
 * Server-side query rewriter for retrieval recall.
 *
 * Conversational / underspecified questions retrieve poorly:
 *   - Filler ("I think we discussed X earlier, can you remind me…") embeds and
 *     keyword-matches noisily, so the gold session ranks below the cutoff.
 *   - Synonym gaps ("how many doctors") miss sessions that say
 *     "physician" / "ENT" / "dermatologist".
 *
 * This helper asks a small LLM to rewrite the question into a few focused
 * keyword search queries (filler stripped, synonym variants added). The caller
 * (read_knowledge / get_content) invokes it ONLY as an on-miss rescue: when the
 * primary single-query search returns nothing, it searches each variant with an
 * over-fetched internal limit and FUSES the candidates by best relevance score
 * per event, recovering a session the raw phrasing could not reach. There is no
 * caller-facing flag — the rescue self-heals on a total miss, so a query that
 * already found something never pays for it.
 *
 * Statelessness: this is a pure per-request retrieval helper. It holds no
 * shared/in-memory state, so it is trivially correct under N>1 app replicas —
 * each request rewrites independently, nothing to fan out across pods.
 *
 * Credentials come from an org-owned API-key provider row via the
 * shared gateway completion client. An unsupported or missing provider (or any
 * failure) yields [] and the caller falls back to the raw query alone.
 */

import logger from './logger';
import { getErrorMessage } from "@lobu/core";
import {
  gatewayCompletion,
  resolveCompletionTarget,
} from '../gateway/inference/gateway-completion.js';

const MAX_INPUT_CHARS = 12_000;
const TIMEOUT_MS = 30_000;
const MAX_VARIANTS = 4;

const SYSTEM_PROMPT =
  'Rewrite the user\'s question into 3 short keyword search queries that retrieve the relevant past conversation sessions from a memory store. Strip conversational filler. Include synonym variants (doctor/physician/specialist; job/role/position). Return STRICT JSON {"queries":["...","...","..."]} only.';

/**
 * Rewrite a conversational/underspecified query into up to 4 focused keyword
 * search-query variants (NOT including the original). Returns [] on any failure
 * or when the org has no resolvable model — the caller falls back to the raw
 * query only.
 */
export async function rewriteQueries(
  query: string,
  organizationId: string
): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const input = trimmed.slice(0, MAX_INPUT_CHARS);

  try {
    const target = await resolveCompletionTarget(organizationId);
    // No supported target means the raw query remains the only variant.
    if (!target) return [];

    const content = await gatewayCompletion({
      target,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: input,
      temperature: 0,
      timeoutMs: TIMEOUT_MS,
    });
    return parseQueries(content);
  } catch (error) {
    // Fail open: any error (timeout/abort, network, parse) means the caller
    // proceeds with the raw query alone.
    logger.warn(
      { error: getErrorMessage(error) },
      '[query-rewriter] rewrite failed; falling back to raw query'
    );
    return [];
  }
}

/**
 * Parse the model's `{"queries":[...]}` JSON (tolerating markdown code fences),
 * drop empties, and cap at MAX_VARIANTS.
 */
function parseQueries(raw: string): string[] {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];
  const queries = (parsed as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) return [];

  const out: string[] = [];
  for (const q of queries) {
    if (typeof q !== 'string') continue;
    const v = q.trim();
    if (v.length === 0) continue;
    out.push(v);
    if (out.length >= MAX_VARIANTS) break;
  }
  return out;
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ? fenced[1].trim() : text;
}
