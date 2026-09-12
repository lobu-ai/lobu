import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sdkLogger } from '../logger.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CDP_URLS = [
  'http://127.0.0.1:9222',
  'http://localhost:9222',
  'http://127.0.0.1:9223',
];

export interface CdpVersionInfo {
  Browser?: string;
  webSocketDebuggerUrl?: string;
  /** Whether the browser is headless (test/automation instance) */
  isHeadless?: boolean;
}

function normalizeCdpUrl(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}

// ---------------------------------------------------------------------------
// HTTP-based discovery (old style: --remote-debugging-port)
// ---------------------------------------------------------------------------

export async function fetchCdpVersionInfo(baseUrl: string): Promise<CdpVersionInfo | null> {
  const url = normalizeCdpUrl(baseUrl);

  try {
    const resp = await fetch(`${url}/json/version`, { headers: { Host: 'localhost' } });
    if (!resp.ok) return null;

    const info = (await resp.json()) as CdpVersionInfo;
    if (!info.webSocketDebuggerUrl) return null;

    const ua = (info as Record<string, unknown>)['User-Agent'] as string | undefined;
    info.isHeadless = ua ? /headless/i.test(ua) : false;
    return info;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

/**
 * Discover Chrome processes listening on TCP ports by parsing `lsof` output.
 * Returns ports for processes named "Google" (Chrome) on macOS/Linux.
 */
async function discoverChromeListeningPorts(): Promise<number[]> {
  if (process.platform === 'win32') return [];

  try {
    const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
      timeout: 5000,
    });
    const ports: number[] = [];

    for (const line of stdout.split('\n')) {
      // Match Chrome processes: "Google" (macOS Chrome) or "chrome"/"chromium" (Linux)
      if (!/^Google\s|^chrome\s|^chromium\s/i.test(line)) continue;

      const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
      if (portMatch) {
        ports.push(Number(portMatch[1]));
      }
    }

    return [...new Set(ports)];
  } catch {
    return [];
  }
}

/**
 * Discover Chrome processes launched with --remote-debugging-port flag.
 * Returns http:// URLs for those endpoints.
 */
async function discoverChromeProcessCdpUrls(): Promise<string[]> {
  if (process.platform === 'win32') return [];

  try {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'command=']);
    const urls = new Set<string>();

    for (const line of stdout.split('\n')) {
      if (!/chrome|chromium|google chrome/i.test(line)) continue;

      const portMatch = line.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
      if (!portMatch) continue;

      const addressMatch = line.match(/--remote-debugging-address(?:=|\s+)([^\s]+)/);
      const host =
        addressMatch?.[1] && addressMatch[1] !== '0.0.0.0' ? addressMatch[1] : '127.0.0.1';
      urls.add(`http://${host}:${portMatch[1]}`);
    }

    return [...urls];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export interface ResolveCdpOptions {
  defaultUrls?: string[];
  loggerLabel?: string;
  /** If true, prefer non-headless (real user) browsers over headless instances */
  preferRealBrowser?: boolean;
}

/**
 * Resolve a CDP endpoint URL. Tries multiple discovery strategies:
 *
 * 1. Explicit URL (if not 'auto')
 * 2. WebSocket probe on Chrome listening ports (new DevTools UI style)
 * 3. HTTP /json/version on --remote-debugging-port URLs (old style)
 * 4. HTTP /json/version on default ports (9222, 9223)
 *
 * When `preferRealBrowser` is true (default), non-headless browsers are
 * returned first. Returns the `ws://` URL for direct WebSocket connections.
 */
export async function resolveCdpUrl(
  input?: string | null,
  options?: ResolveCdpOptions
): Promise<string> {
  const label = options?.loggerLabel;
  const preferReal = options?.preferRealBrowser ?? true;
  const normalizedInput = input?.trim();

  // Explicit URL — resolve to ws:// if possible
  if (normalizedInput && normalizedInput.toLowerCase() !== 'auto') {
    const url = normalizeCdpUrl(normalizedInput);
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    // Try HTTP /json/version to get the ws:// URL
    const info = await fetchCdpVersionInfo(url);
    if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    // No HTTP endpoint — assume new-style DevTools UI. Build ws:// URL from the http:// URL.
    // Don't probe via WS here to avoid triggering Chrome's permission dialog.
    try {
      const parsed = new URL(url);
      return `ws://${parsed.hostname}:${parsed.port}/devtools/browser`;
    } catch {
      return url;
    }
  }

  // --- Strategy 1: Probe Chrome listening ports ---
  // HTTP-only discovery: check /json/version on each port. This is non-intrusive
  // and doesn't trigger Chrome's "Allow remote debugging?" permission dialog.
  //
  // For Chrome's new DevTools UI style (WS-only, no HTTP), we can't probe without
  // triggering the dialog. Instead we build a ws:// candidate URL for any Chrome
  // port that doesn't serve HTTP. The actual connection happens once in
  // acquireBrowser() via CdpPage, which is when the user clicks "Allow".
  const listeningPorts = await discoverChromeListeningPorts();
  const discovered: Array<{ wsUrl: string; info: CdpVersionInfo }> = [];

  for (const port of listeningPorts) {
    const httpInfo = await fetchCdpVersionInfo(`http://127.0.0.1:${port}`);
    if (httpInfo?.webSocketDebuggerUrl) {
      discovered.push({ wsUrl: httpInfo.webSocketDebuggerUrl, info: httpInfo });
    } else {
      // No HTTP endpoint — assume new-style DevTools UI (ws-only).
      // Add as a candidate without probing. We mark it as non-headless because
      // the DevTools UI checkbox is only available in the user's real Chrome.
      discovered.push({
        wsUrl: `ws://127.0.0.1:${port}/devtools/browser`,
        info: {
          Browser: 'Chrome (DevTools UI)',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser`,
          isHeadless: false,
        },
      });
    }
  }

  // --- Strategy 2: Also check --remote-debugging-port processes + default ports ---
  const processUrls = await discoverChromeProcessCdpUrls();
  const extraCandidates = new Set<string>([
    ...processUrls,
    ...(options?.defaultUrls ?? DEFAULT_CDP_URLS),
  ]);
  // Remove ports we already probed
  const probedPorts = new Set(listeningPorts);
  for (const candidate of extraCandidates) {
    try {
      const port = Number(new URL(candidate).port);
      if (probedPorts.has(port)) continue;
    } catch {
      /* ignore parse errors */
    }

    const info = await fetchCdpVersionInfo(candidate);
    if (info?.webSocketDebuggerUrl) {
      discovered.push({ wsUrl: info.webSocketDebuggerUrl, info });
    }
  }

  // Pick the best: prefer real (non-headless) browsers
  if (discovered.length > 0) {
    const sorted = preferReal
      ? discovered.sort((a, b) =>
          a.info.isHeadless === b.info.isHeadless ? 0 : a.info.isHeadless ? 1 : -1
        )
      : discovered;
    const best = sorted[0];
    if (label) {
      sdkLogger.info(
        { wsUrl: best.wsUrl, browser: best.info.Browser, headless: best.info.isHeadless },
        `[${label}] Auto-detected CDP endpoint`
      );
    }
    return best.wsUrl;
  }

  throw new Error(
    'Could not auto-detect a Chrome DevTools endpoint.\n' +
      'Enable remote debugging in Chrome: chrome://inspect/#remote-debugging\n' +
      'Or start Chrome with: --remote-debugging-port=9222'
  );
}
