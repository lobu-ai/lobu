/**
 * HTML templates for OAuth flow
 */

import { escapeHtml } from "../../utils/html.js";

/**
 * Allow http(s) absolute URLs and same-origin path-relative URLs. Reject
 * anything that could redirect off-origin via backslash or evaluate as a
 * `javascript:` / `data:` scheme inside an `href`.
 */
function isSafeHttpHref(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) {
    if (trimmed.length > 1 && (trimmed[1] === "/" || trimmed[1] === "\\")) {
      return false;
    }
    return !/[\r\n]/.test(trimmed);
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Render a success page that auto-closes the tab (for in-app browsers)
 * and provides a fallback link to agent configuration when available.
 */
export function renderOAuthSuccessPage(
  name: string,
  settingsUrl?: string,
  options?: {
    title?: string;
    description?: string;
    details?: string;
    closeNote?: string;
  }
): string {
  const safeName = escapeHtml(name);
  // `escapeHtml` keeps `javascript:` schemes intact, so the href would still
  // execute script if a caller ever passed an untrusted URL. Only emit the
  // button when the URL is http(s) or same-origin path-relative.
  const safeSettingsUrl =
    settingsUrl && isSafeHttpHref(settingsUrl) ? escapeHtml(settingsUrl) : "";
  const safeTitle = escapeHtml(options?.title || "Connected!");
  const safeDescription = escapeHtml(
    options?.description || `Successfully authenticated with ${name}`
  );
  const safeDetails = options?.details ? escapeHtml(options.details) : "";
  const safeCloseNote = escapeHtml(
    options?.closeNote || "You can close this tab and return to your chat."
  );

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Connected</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #334155 0%, #0f172a 100%);
          }
          .container {
            background: white;
            padding: 2.5rem;
            border-radius: 12px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 360px;
          }
          .icon { font-size: 3rem; margin-bottom: 0.75rem; }
          h1 { color: #2d3748; margin: 0 0 0.5rem 0; font-size: 1.25rem; }
          p { color: #718096; line-height: 1.5; font-size: 0.875rem; margin: 0 0 1rem 0; }
          .btn {
            display: inline-block;
            padding: 0.625rem 1.25rem;
            background: linear-gradient(to right, #334155, #1e293b);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 0.875rem;
            font-weight: 600;
          }
          .btn:hover { opacity: 0.9; }
          .close-note { color: #94a3b8; font-size: 0.75rem; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">&#9989;</div>
          <h1>${safeTitle}</h1>
          <p>${safeDescription.includes(safeName) ? safeDescription : `${safeDescription} <strong>${safeName}</strong>`}</p>
          ${safeDetails ? `<p>${safeDetails}</p>` : ""}
          ${safeSettingsUrl ? `<a class="btn" href="${safeSettingsUrl}">Open Configuration</a>` : ""}
          <p class="close-note">${safeCloseNote}</p>
        </div>
        <script>
          // Auto-close for Telegram in-app browser
          if (window.Telegram && window.Telegram.WebApp) {
            window.Telegram.WebApp.close();
          }
          // Try to close the window/tab after a brief moment
          setTimeout(function() { window.close(); }, 1500);
        </script>
      </body>
    </html>
  `;
}

/**
 * Shared layout for managed-connection and chat-account pages, plus OAuth
 * errors. Based on Lobu's tokens (`packages/owletto/src/index.css`), inline so
 * the page needs no other request. `body` is trusted HTML: callers escape
 * every value they interpolate. `details` is an error code, escaped here.
 */
export function renderLobuPage(options: {
  title: string;
  body: string;
  details?: string;
}): string {
  const details = options.details
    ? `<details><summary>Technical details</summary><code>${escapeHtml(options.details)}</code></details>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta name="referrer" content="strict-origin">
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { --bg: #fcfcfb; --fg: #141414; --card: #ffffff; --muted: #545454;
        --border: #e7e4dc; --primary: #2f63e8; --primary-fg: #fcfcfb; --link: #2f63e8; --subtle: #f4f2ec; }
      @media (prefers-color-scheme: dark) {
        :root { --bg: #0f0e0c; --fg: #f3eee2; --card: #1a1815; --muted: #b4ae9f;
          --border: #2c2a25; --primary: #2f63e8; --primary-fg: #fcfcfb; --link: #8aabff; --subtle: #22201c; }
      }
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body { margin: 0; min-height: 100vh; min-height: 100dvh; padding: 24px 16px;
        display: flex; align-items: center; justify-content: center;
        background: var(--bg); color: var(--fg);
        font: 15px/1.6 "DM Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      .lobu-card { width: 100%; max-width: 460px; background: var(--card);
        border: 1px solid var(--border); padding: 32px; }
      .lobu-brand { margin: 0 0 24px; font-size: 13px; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
      h1 { margin: 0 0 12px; font-size: 22px; line-height: 1.3; font-weight: 600; }
      p { margin: 0 0 16px; }
      .lobu-card p { color: var(--muted); }
      .lobu-card p strong, .lobu-card p code { color: var(--fg); }
      a { color: var(--link); }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
        overflow-wrap: anywhere; }
      pre { margin: 0 0 16px; padding: 12px; overflow-x: auto; background: var(--subtle); }
      dl { margin: 0 0 24px; border: 1px solid var(--border); }
      dl > div { padding: 12px 16px; }
      dl > div + div { border-top: 1px solid var(--border); }
      dt { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--muted); }
      dd { margin: 2px 0 0; overflow-wrap: anywhere; }
      form { margin: 0; }
      .actions { display: flex; flex-direction: column; gap: 12px; margin-top: 24px; }
      .btn { display: block; width: 100%; padding: 12px 16px; border: 1px solid var(--primary);
        background: var(--primary); color: var(--primary-fg); font: inherit; font-weight: 600;
        text-align: center; text-decoration: none; cursor: pointer; }
      .btn:hover { filter: brightness(1.08); }
      .btn:focus-visible, .link-btn:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
      .btn-secondary { background: transparent; color: var(--fg); border-color: var(--border); }
      .btn-secondary:hover { filter: none; background: var(--subtle); }
      .switch { margin: 16px 0 0; font-size: 14px; color: var(--muted); }
      .link-btn { padding: 0; border: 0; background: none; font: inherit; color: var(--link);
        text-decoration: underline; cursor: pointer; }
      .note { margin-top: 16px; font-size: 13px; }
      details { margin-top: 24px; color: var(--muted); font-size: 13px; }
      details code { display: block; margin-top: 8px; }
      @media (max-width: 480px) { .lobu-card { padding: 24px 20px; } h1 { font-size: 20px; } }
    </style>
  </head>
  <body>
    <main class="lobu-card">
      <p class="lobu-brand">Lobu</p>
      <h1>${escapeHtml(options.title)}</h1>
      ${options.body}
      ${details}
    </main>
  </body>
</html>`;
}

export function renderOAuthErrorPage(
  error: string,
  description?: string,
  options?: { title: string; actionUrl?: string; actionLabel?: string }
): string {
  const safeDescription = escapeHtml(
    description || "An error occurred during authentication"
  );
  const actionUrl = options?.actionUrl && isSafeHttpHref(options.actionUrl)
    ? escapeHtml(options.actionUrl) : "";
  const actionLabel = escapeHtml(options?.actionLabel ?? "Return to Lobu");

  return renderLobuPage({
    title: options?.title ?? "Authentication Failed",
    body: `<p>${safeDescription}</p>${
      actionUrl
        ? `<div class="actions"><a class="btn" href="${actionUrl}">${actionLabel}</a></div>`
        : "<p>Return to Lobu to check the connection and start authorization again.</p>"
    }`,
    details: error,
  });
}
