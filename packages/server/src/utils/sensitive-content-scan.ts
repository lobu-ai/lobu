/**
 * Pure secret and PII detectors shared by the `secret-scan` / `pii-scan`
 * guardrails and `scan` conditions on policy rules. One copy, so both callers
 * agree on what counts as a secret or PII.
 */

// -- pii --------------------------------------------------------------------

/**
 * Cheap shape patterns tried first; first match wins. Credit cards are
 * handled separately by `scanCreditCard` because we need `matchAll` to
 * iterate every candidate — a non-Luhn invoice number appearing before a
 * real PAN would otherwise shadow it.
 */
const PII_SHAPE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: "email",
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  },
  // Anchored with non-digit boundaries so it doesn't fire on long numeric runs.
  {
    kind: "us-phone",
    pattern:
      /(?:^|[^\d])(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  },
];

/**
 * Candidate credit-card-shaped runs: 13-19 digits with optional single
 * space/hyphen separators. `g`-flagged for `matchAll`.
 */
const CC_CANDIDATE_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

function scanCreditCard(text: string): { kind: string; match: string } | null {
  for (const m of text.matchAll(CC_CANDIDATE_PATTERN)) {
    if (luhnValid(m[0])) return { kind: "credit-card", match: m[0] };
  }
  return null;
}

/**
 * Standard Luhn check on a 13-19 digit string, separators stripped.
 */
export function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits.charCodeAt(i) - 48; // '0' = 48
    let v = d;
    if (alt) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function scanForPii(text: string): { kind: string; match: string } | null {
  for (const { kind, pattern } of PII_SHAPE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { kind, match: m[0] };
  }
  return scanCreditCard(text);
}

// -- secrets ----------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Allow hyphens so prefixed keys (Anthropic `sk-ant-…`, OpenAI `sk-proj-…`)
  // are matched, not truncated at the first hyphen.
  { name: "openai-key", re: /sk-[a-zA-Z0-9-]{20,}/ },
  // GitHub tokens: classic PAT (ghp_) AND OAuth/app/user/refresh tokens
  // (gho_/ghu_/ghs_/ghr_) — the `ghp_`-only pattern missed every non-PAT form.
  { name: "github-token", re: /gh[oprsu]_[A-Za-z0-9]{36,}/ },
  // GitHub fine-grained PAT (`github_pat_…`) — a different shape entirely.
  { name: "github-fine-grained-pat", re: /github_pat_[0-9A-Za-z_]{22,}/ },
  // AWS access key IDs. AKIA = long-term; ASIA = temporary/STS session creds
  // (ubiquitous in assumed-role agent environments); AGPA/AIDA/AROA = other
  // principal-id prefixes. The AKIA-only pattern missed STS keys entirely.
  { name: "aws-access-key", re: /(AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}/ },
  // JWT: header.payload.signature, all base64url. Header AND payload each
  // base64url-encode a JSON object, so both begin `eyJ`. The previous `{40,}`
  // floor on the header missed standard tokens — a canonical HS256 header is
  // only 33 base64url chars after `eyJ`. Require `eyJ` on the first two
  // segments (a strong structural signal that avoids false positives) with a
  // sane minimum length on each.
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/** The name of the first secret shape found in `text`, or null. */
export function scanForSecret(text: string): string | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
