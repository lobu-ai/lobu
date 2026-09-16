/**
 * OAuth 2.1 Utility Functions
 *
 * Token generation, hashing, PKCE validation, and other OAuth utilities.
 */

import { createHash, randomBytes } from 'node:crypto';
import { generateCodeChallenge } from '../../utils/pkce';
import { AVAILABLE_SCOPES, DEFAULT_SCOPES } from './scopes';

// ============================================
// Token Generation
// ============================================

/**
 * Generate a cryptographically secure random string
 */
export function generateSecureToken(length: number = 32): string {
  return randomBytes(length).toString('base64url');
}

/**
 * Generate an OAuth client ID
 * Format: mcp_client_<random>
 */
export function generateClientId(): string {
  return `mcp_client_${generateSecureToken(16)}`;
}

/**
 * Generate an OAuth client secret
 * Format: mcp_secret_<random>
 */
export function generateClientSecret(): string {
  return `mcp_secret_${generateSecureToken(32)}`;
}

/**
 * Generate an authorization code
 * Format: <random> (43 chars, suitable for PKCE)
 */
export function generateAuthorizationCode(): string {
  return generateSecureToken(32);
}

/**
 * Generate an access token
 * Format: <random>
 */
export function generateAccessToken(): string {
  return generateSecureToken(32);
}

/**
 * Generate a refresh token
 * Format: <random>
 */
export function generateRefreshToken(): string {
  return generateSecureToken(48);
}

/**
 * Generate a Personal Access Token (PAT)
 * Format: owl_pat_<random>
 */
export function generatePAT(): string {
  return `owl_pat_${generateSecureToken(24)}`;
}

/**
 * Generate a unique ID for database records
 */
export function generateId(): string {
  return generateSecureToken(16);
}

/**
 * Generate a device code (RFC 8628)
 * Long random string used for polling
 */
export function generateDeviceCode(): string {
  return generateSecureToken(32);
}

/**
 * Generate a user code (RFC 8628)
 * Short, human-readable code like "ABCD-1234"
 * Uses uppercase letters (no O/I/L to avoid confusion) and digits (no 0/1)
 */
export function generateUserCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chars: string[] = [];
  // Use rejection sampling to avoid modulo bias (alphabet.length=30, 256%30=16)
  while (chars.length < 8) {
    const bytes = randomBytes(8 - chars.length);
    for (let i = 0; i < bytes.length && chars.length < 8; i++) {
      // Largest multiple of 30 that fits in a byte: 240 (30*8)
      if (bytes[i] < 240) {
        chars.push(alphabet[bytes[i] % alphabet.length]);
      }
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

// ============================================
// Hashing
// ============================================

/**
 * Hash a token using SHA-256
 * Used for storing tokens securely in the database
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Privacy-safe correlation id for a `device_code`.
 *
 * Device flow spans four requests across two clients (the CLI's
 * `/device_authorization` and `/token` polls, the browser's `/device/info` and
 * `/device/approve`). Correlating them needs one stable key per authorization,
 * but a raw `device_code` is a bearer credential and must never reach a log
 * sink. A truncated SHA-256 is stable across those requests and
 * non-reversible, so a log reader can join the sites without learning a code.
 *
 * Only `device_code` is passed here. A `user_code` is short and
 * human-typeable, so its keyspace is small enough to enumerate offline — a
 * hash of one is not privacy-preserving and would be a false assurance.
 * Correlation therefore keys on the device code everywhere, and the sites that
 * only hold a user code log the device code returned by their own query.
 *
 * Every site derives this through THIS function so they all land in one
 * namespace — a prefix taken off a raw code elsewhere would look right and
 * join nothing (see root AGENTS.md on shared keys).
 */
export function deviceCodeCorrelationId(deviceCode: string): string {
  return hashToken(deviceCode).slice(0, 12);
}

/**
 * Get the prefix of a PAT for display
 */
export function getPATPrefix(key: string): string {
  // For owl_pat_xxx format, return first 12 chars
  return key.substring(0, 12);
}

// ============================================
// PKCE (Proof Key for Code Exchange)
// ============================================

/**
 * Verify a PKCE code verifier against a stored challenge
 */
export function verifyCodeChallenge(
  verifier: string,
  challenge: string,
  method: 'S256' | 'plain' = 'S256'
): boolean {
  if (method === 'plain') {
    return verifier === challenge;
  }

  // S256: challenge = BASE64URL(SHA256(verifier))
  const computedChallenge = generateCodeChallenge(verifier);
  return computedChallenge === challenge;
}

// ============================================
// Token Expiry
// ============================================

/** Access token lifetime: 24 hours */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 3600;

/** Refresh token lifetime: 30 days */
export const REFRESH_TOKEN_LIFETIME_SECONDS = 30 * 24 * 3600;

/** Authorization code lifetime: 10 minutes */
export const AUTHORIZATION_CODE_LIFETIME_SECONDS = 600;

/** Device code lifetime: 15 minutes */
export const DEVICE_CODE_LIFETIME_SECONDS = 900;

/** Default polling interval for device code flow: 5 seconds */
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;

/**
 * Calculate expiry date from now
 */
export function calculateExpiry(lifetimeSeconds: number): Date {
  return new Date(Date.now() + lifetimeSeconds * 1000);
}

// ============================================
// Scope Utilities
// ============================================

/**
 * Parse scope string into array
 */
export function parseScopes(scope: string | null | undefined): string[] {
  if (!scope) return [...DEFAULT_SCOPES];
  return scope.split(' ').filter((s) => (AVAILABLE_SCOPES as readonly string[]).includes(s));
}

// ============================================
// URL Validation
// ============================================

/**
 * Validate a redirect URI
 * - Must be absolute HTTPS URL (or http://localhost for development)
 * - No fragments allowed
 */
export function validateRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;

    if (url.protocol === 'https:') return true;

    if (url.protocol === 'http:') {
      const hostname = url.hostname.toLowerCase();
      return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]'
      );
    }

    return false;
  } catch {
    return false;
  }
}

// ============================================
// Error Types
// ============================================

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token';

export interface OAuthError {
  error: OAuthErrorCode;
  error_description?: string;
  error_uri?: string;
}

export function createOAuthError(code: OAuthErrorCode, description?: string): OAuthError {
  return {
    error: code,
    error_description: description,
  };
}
