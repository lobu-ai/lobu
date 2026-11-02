/**
 * Shared mutable mock state for the src/lobu route test files.
 *
 * bun:test's `mock.module` is process-global and module evaluation is cached:
 * the FIRST test file to import `../agent-routes.js` permanently binds it to
 * whatever mock factories are installed at that moment. When each test file
 * registered its own `mock.module('../../auth/middleware', …)` closing over
 * its OWN stash objects, the second file's re-mock never reached the
 * already-evaluated agent-routes module — its requests kept authenticating
 * against the first file's stash (wrong org) and hitting the first file's
 * manager stub, so every lookup 404'd whenever both files ran in one process
 * (`bun test src/lobu/__tests__`), while each file passed alone.
 *
 * Fix: install ONE process-wide mock per specifier, closing over these shared
 * mutable stashes. Each test file sets its per-test values on the stashes in
 * `beforeEach` — bun runs files sequentially in a single process, so there is
 * no cross-talk.
 */
import { mock } from 'bun:test';

export interface AuthStash {
  user: { id: string; name: string; email: string; emailVerified: boolean } | null;
  organizationId: string | null;
  // `authSource` mirrors the real middleware contract so admin-tier routes
  // gated by `requireSessionOrAdminPat` see a non-null value.
  authSource: 'session' | 'pat' | 'oauth' | null;
  mcpAuthInfo: { scopes: string[] } | null;
  memberRole: string | null;
}

/** Mutable holder the mocked `mcpAuth` middleware copies onto the Hono context. */
export const authStash: AuthStash = {
  user: { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true },
  organizationId: 'org-a',
  authSource: 'session',
  mcpAuthInfo: null,
  memberRole: 'owner',
};

/**
 * Mutable holder for whatever `getChatInstanceManager()` should return —
 * a delegating stub (agent-routes-apply.test.ts) or the real
 * ChatInstanceManager (agent-routes-rest-platform.test.ts).
 */
export const chatManagerStash: { manager: any } = { manager: null };

/**
 * Mutable holder for whatever `getLobuCoreServices()` should return. Defaults
 * to `null` (the historical semantics every other route test relies on); the
 * OAuth-route test (agent-routes-oauth-redirect.test.ts) sets it to a REAL
 * `AuthProfilesManager` + OAuth state store (DB-backed, via
 * `buildRealClaudeAuthStack()`) so the
 * `/providers/:provider/oauth/{start,code}` handlers run against the genuine
 * `upsertProfile` guard — not a fake that would mask a missing `userId`.
 */
export const coreServicesStash: { services: any } = { services: null };

let installed = false;

/**
 * Idempotent: the module mocks are installed once per process, bound to the
 * shared stashes above. Call at the top of every test file that imports
 * `../agent-routes.js` (directly or transitively), BEFORE that import runs.
 */
export function installRouteTestMocks(): void {
  if (installed) return;
  installed = true;

  // Specifiers resolve relative to THIS helper file
  // (`src/lobu/__tests__/helpers/`), so ../../../auth/middleware →
  // src/auth/middleware and ../../gateway → src/lobu/gateway — the modules
  // agent-routes actually imports. Extra relative forms would resolve to
  // non-existent paths from here and only add mock noise (review: slop).
  mock.module('../../../auth/middleware', () => ({
    mcpAuth: async (c: any, next: any) => {
      c.set('user', authStash.user);
      c.set('session', authStash.authSource === 'session' && authStash.user ? { userId: authStash.user.id } : null);
      c.set('mcpIsAuthenticated', authStash.authSource !== null);
      c.set('organizationId', authStash.organizationId);
      c.set('authSource', authStash.authSource);
      c.set('mcpAuthInfo', authStash.mcpAuthInfo);
      c.set('memberRole', authStash.memberRole);
      return next();
    },
    requireAuth: async (_c: any, next: any) => next(),
  }));

  mock.module('../../gateway', () => ({
    getChatInstanceManager: () => chatManagerStash.manager,
    getLobuCoreServices: () => coreServicesStash.services,
    initLobuGateway: async () => null,
    stopLobuGateway: async () => {},
    isLobuGatewayRunning: () => false,
    ensureEmbeddedGatewaySecrets: () => {},
  }));
}
