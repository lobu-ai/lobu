/**
 * OAuth utility hardening tests
 *
 * Covers token generation, hashing, PKCE, scope parsing, and redirect URI
 * validation without requiring a database connection.
 */

import { describe, expect, test } from "vitest";
import { AVAILABLE_PAT_SCOPES, DEFAULT_SCOPES, DISCOVERY_SCOPES, normalizeOAuthScopeRequest, POLICY_WRITE_SCOPE } from "../oauth/scopes";
import {
  generatePAT,
  generateUserCode,
  getPATPrefix,
  hashToken,
  parseScopes,
  validateRedirectUri,
  verifyCodeChallenge,
} from "../oauth/utils";

// ─── generatePAT ─────────────────────────────────────────────────────────────

describe("generatePAT", () => {
  test("has owl_pat_ prefix", () => {
    expect(generatePAT()).toMatch(/^owl_pat_/);
  });

  test("two calls produce different tokens", () => {
    expect(generatePAT()).not.toBe(generatePAT());
  });

  test("token is URL-safe base64url (no +, /, =)", () => {
    for (let i = 0; i < 20; i++) {
      const token = generatePAT().replace("owl_pat_", "");
      expect(token).not.toMatch(/[+/=]/);
    }
  });
});

// ─── hashToken ────────────────────────────────────────────────────────────────

describe("hashToken", () => {
  test("returns a hex string of length 64 (SHA-256)", () => {
    const h = hashToken("owl_pat_abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input produces same hash (deterministic)", () => {
    const token = "owl_pat_deterministic";
    expect(hashToken(token)).toBe(hashToken(token));
  });

  test("different inputs produce different hashes", () => {
    expect(hashToken("owl_pat_a")).not.toBe(hashToken("owl_pat_b"));
  });

  test("empty string hashes consistently", () => {
    const h = hashToken("");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── getPATPrefix ─────────────────────────────────────────────────────────────

describe("getPATPrefix", () => {
  test("returns first 12 characters of the token", () => {
    const token = "owl_pat_ABCDEFGHIJKLMNOPQRST";
    expect(getPATPrefix(token)).toBe("owl_pat_ABCD");
    expect(getPATPrefix(token)).toHaveLength(12);
  });

  test("prefix always starts with owl_pat for PATs", () => {
    const prefix = getPATPrefix(generatePAT());
    expect(prefix).toMatch(/^owl_pat_/);
  });
});

// ─── verifyCodeChallenge (PKCE) ───────────────────────────────────────────────

describe("verifyCodeChallenge — S256", () => {
  // Python reference: base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b'=')
  test("accepts matching S256 verifier/challenge pair", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const { createHash } = require("node:crypto");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    expect(verifyCodeChallenge(verifier, challenge, "S256")).toBe(true);
  });

  test("rejects wrong verifier for a correct challenge", () => {
    const { createHash } = require("node:crypto");
    const correctVerifier = "correct-verifier-value-long-enough-to-hash";
    const challenge = createHash("sha256")
      .update(correctVerifier)
      .digest("base64url");
    expect(verifyCodeChallenge("wrong-verifier", challenge, "S256")).toBe(false);
  });

  test("S256 is the default method", () => {
    const { createHash } = require("node:crypto");
    const verifier = "my-test-verifier-value-that-is-long-enough";
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    // No method argument → defaults to S256
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });
});

describe("verifyCodeChallenge — plain", () => {
  test("accepts when verifier equals challenge exactly", () => {
    const v = "plain-secret-code-verifier";
    expect(verifyCodeChallenge(v, v, "plain")).toBe(true);
  });

  test("rejects when verifier differs from challenge", () => {
    expect(verifyCodeChallenge("aaa", "bbb", "plain")).toBe(false);
  });

  test("plain is case-sensitive", () => {
    expect(verifyCodeChallenge("ABC", "abc", "plain")).toBe(false);
  });
});

// ─── parseScopes ─────────────────────────────────────────────────────────────

describe("parseScopes", () => {
  test("policy management is explicitly mintable on PATs, never on OAuth or default grants", () => {
    expect(AVAILABLE_PAT_SCOPES).toContain(POLICY_WRITE_SCOPE);
    expect(DEFAULT_SCOPES).not.toContain(POLICY_WRITE_SCOPE);
    expect(DISCOVERY_SCOPES).not.toContain(POLICY_WRITE_SCOPE);
    expect(normalizeOAuthScopeRequest(POLICY_WRITE_SCOPE)).toBeNull();
    expect(parseScopes(POLICY_WRITE_SCOPE)).toEqual([]);
    expect(parseScopes(POLICY_WRITE_SCOPE, AVAILABLE_PAT_SCOPES)).toEqual([POLICY_WRITE_SCOPE]);
  });
  test("null/undefined → default scopes (at least one scope)", () => {
    const defaults = parseScopes(null);
    expect(Array.isArray(defaults)).toBe(true);
    expect(defaults.length).toBeGreaterThan(0);
    // Same for undefined
    expect(parseScopes(undefined)).toEqual(defaults);
  });

  test("known scopes are retained", () => {
    const scopes = parseScopes("mcp:read mcp:write");
    expect(scopes).toContain("mcp:read");
    expect(scopes).toContain("mcp:write");
  });

  test("unknown/invented scopes are filtered out", () => {
    const scopes = parseScopes("mcp:read evil:scope unknown:thing");
    expect(scopes).toContain("mcp:read");
    expect(scopes).not.toContain("evil:scope");
    expect(scopes).not.toContain("unknown:thing");
  });

  test("mcp:admin is a valid scope when declared", () => {
    const scopes = parseScopes("mcp:read mcp:write mcp:admin");
    expect(scopes).toContain("mcp:admin");
  });

  test("empty string → default scopes", () => {
    const defaults = parseScopes(null);
    expect(parseScopes("")).toEqual(defaults);
  });

  test("scope string with only unknown values → empty array (not defaults)", () => {
    // Non-empty string bypasses the !scope early-return, so unknown scopes
    // are filtered to [] — NOT DEFAULT_SCOPES. This documents the actual
    // automation: defaults are only returned for null/undefined/"".
    expect(parseScopes("completely:invented scope:xyz")).toEqual([]);
  });
});

// ─── validateRedirectUri ──────────────────────────────────────────────────────

describe("validateRedirectUri", () => {
  test("https:// URL is accepted", () => {
    expect(validateRedirectUri("https://example.com/callback")).toBe(true);
  });

  test("https:// URL with path and query is accepted", () => {
    expect(
      validateRedirectUri("https://app.example.com/auth/callback?foo=bar")
    ).toBe(true);
  });

  test("http://localhost is accepted", () => {
    expect(validateRedirectUri("http://localhost/callback")).toBe(true);
  });

  test("http://127.0.0.1 is accepted", () => {
    expect(validateRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
  });

  test("http://[::1] is accepted", () => {
    expect(validateRedirectUri("http://[::1]/callback")).toBe(true);
  });

  test("http://::1 bare (no brackets) is rejected — not a valid URL", () => {
    // The URL parser requires brackets for IPv6: http://[::1]/ is valid,
    // http://::1/ is not. This documents the code's actual semantics.
    expect(validateRedirectUri("http://::1/callback")).toBe(false);
  });

  test("http:// non-localhost URL is rejected", () => {
    expect(validateRedirectUri("http://evil.example.com/callback")).toBe(false);
  });

  test("ftp:// URL is rejected", () => {
    expect(validateRedirectUri("ftp://example.com/callback")).toBe(false);
  });

  test("URL with fragment is rejected", () => {
    expect(validateRedirectUri("https://example.com/callback#token=abc")).toBe(
      false
    );
  });

  test("completely invalid URL string is rejected", () => {
    expect(validateRedirectUri("not-a-url")).toBe(false);
  });

  test("empty string is rejected", () => {
    expect(validateRedirectUri("")).toBe(false);
  });

  test("javascript: URI is rejected", () => {
    expect(validateRedirectUri("javascript:alert(1)")).toBe(false);
  });
});

// ─── generateUserCode (device auth) ──────────────────────────────────────────

describe("generateUserCode", () => {
  test("format is XXXX-XXXX (4-dash-4 chars)", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  test("no ambiguous characters (O, I, L, 0, 1)", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      expect(code).not.toMatch(/[OIL01]/);
    }
  });

  test("two calls produce different codes", () => {
    const codes = new Set(Array.from({ length: 20 }, generateUserCode));
    expect(codes.size).toBeGreaterThan(1);
  });
});
