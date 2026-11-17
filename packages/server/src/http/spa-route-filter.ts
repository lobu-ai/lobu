import path from 'node:path';

const SPA_ALLOWED_PATHS = new Set(['/oauth/consent', '/oauth/device']);

const SPA_EXCLUDED_PREFIXES = [
  '/.well-known',
  '/api',
  '/connect',
  '/health',
  '/logo.png',
  '/mcp',
  '/openapi.json',
  '/oauth',
];

function normalizeRoutePath(requestPath: string): string {
  const normalized = path.posix.normalize(requestPath || '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function isExcludedSpaPath(requestPath: string): boolean {
  const normalizedPath = normalizeRoutePath(requestPath);
  if (SPA_ALLOWED_PATHS.has(normalizedPath)) {
    return false;
  }
  return SPA_EXCLUDED_PREFIXES.some(
    (prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );
}
