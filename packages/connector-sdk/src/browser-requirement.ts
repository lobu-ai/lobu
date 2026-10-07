import type { ChromeActionDispatcher } from './extension-network.js';

export const BROWSER_VERIFY_OPERATION = 'verify_browser';
export const BROWSER_VERIFY_ACTION = {
  name: 'Verify browser connection', kind: 'read' as const,
  description: 'Check the selected browser and any declared account identity without reading source content.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

/** A delegated browser resource, independent of connector worker placement. */
export interface ConnectorBrowserRequirement {
  /** Exact HTTPS origins the connector may drive. */
  origins: string[];
  /** Omit for every auth mode; use ['browser'] for an OAuth/browser alternative. */
  authMethods?: string[];
  /** Connector-owned, read-only self-identity probe. Never reads source content. */
  accountProbe?: {
    url: string;
    /** Page expression returning { accountId, displayName? }, or null when signed out. */
    expression: string;
  };
}

export function validateBrowserRequirement(value: unknown): asserts value is ConnectorBrowserRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser requirement');
  const browser = value as ConnectorBrowserRequirement;
  if (!Array.isArray(browser.origins) || browser.origins.length === 0) throw new Error('Browser origins must not be empty');
  for (const origin of browser.origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.hostname.includes('*')) {
      throw new Error('Browser origins must be exact HTTPS origins');
    }
  }
  if (browser.authMethods && (!Array.isArray(browser.authMethods) || !browser.authMethods.length || browser.authMethods.some(method => !['none', 'browser', 'oauth', 'env_keys', 'app_installation', 'interactive'].includes(method)))) {
    throw new Error('Invalid browser authMethods');
  }
  if (browser.accountProbe && (!browser.origins.includes(new URL(browser.accountProbe.url).origin) || typeof browser.accountProbe.expression !== 'string' || !browser.accountProbe.expression.trim())) {
    throw new Error('Browser account probe must target a declared origin and provide an expression');
  }
}

/** One auth-mode mapping for setup, discovery and every execution path. */
export function browserAuthMethod(profileKind: string | null | undefined): string {
  return ({ oauth_account: 'oauth', oauth_app: 'oauth', env: 'env_keys', browser_session: 'browser' } as Record<string, string>)[profileKind ?? ''] ?? profileKind ?? 'none';
}

export function resolveBrowserRequirement(value: unknown, authMethod: string): ConnectorBrowserRequirement | null {
  if (value == null) return null;
  validateBrowserRequirement(value);
  return !value.authMethods || value.authMethods.includes(authMethod) ? value : null;
}

/** Replaces caller-supplied `allowed_origins` with the catalog grant; URLs must fall inside it. */
export function constrainBrowserInput(browser: ConnectorBrowserRequirement, actionKey: string, input: Record<string, unknown>): Record<string, unknown> {
  validateBrowserRequirement(browser);
  const allowedActions = ['verify_browser', 'navigate', 'evaluate', 'get_accessibility_tree', 'wait_for_selector', 'screenshot', 'click_ref', 'type_ref', 'press_key', 'scroll', 'focus_tab', 'close_tab', 'list_tabs', 'show_notification', 'network_intercept_start', 'network_intercept_drain', 'network_intercept_stop', 'network_intercept_replay', 'console_capture_start', 'console_capture_drain', 'console_capture_stop'];
  if (!allowedActions.includes(actionKey)) throw new Error('Operation is outside the declared browser resource');
  if (actionKey === 'navigate' && input.url === 'about:blank') return { ...input, allowed_origins: browser.origins };
  for (const key of ['url', 'click_url', 'landed_url']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !browser.origins.includes(new URL(input[key] as string).origin))) {
      throw new Error('Browser URL is outside the connector declared origins');
    }
  }
  if (actionKey === 'navigate' && typeof input.url !== 'string') {
    throw new Error('Browser navigation is outside the connector declared origins');
  }
  return { ...input, allowed_origins: browser.origins };
}

/** Shared accessor for built-in and external connectors. The host owns the grant. */
export function requireBrowser(ctx: { browser?: ChromeActionDispatcher }): ChromeActionDispatcher {
  if (!ctx.browser) throw new Error('Browser setup is required for this connection');
  return ctx.browser;
}
