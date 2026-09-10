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

export function renderOAuthErrorPage(
  error: string,
  description?: string,
  options?: { title: string; actionUrl?: string; actionLabel?: string }
): string {
  const safeError = escapeHtml(error);
  const safeTitle = escapeHtml(options?.title ?? "Authentication Failed");
  const safeDescription = escapeHtml(
    description || "An error occurred during authentication"
  );
  const actionUrl = options?.actionUrl && isSafeHttpHref(options.actionUrl)
    ? escapeHtml(options.actionUrl) : "";
  const actionLabel = escapeHtml(options?.actionLabel ?? "Return to Lobu");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0; padding: 24px; min-height: 100vh; box-sizing: border-box;
        display: grid; place-items: center; background: #fafafa; color: #171717; }
      main { width: 100%; max-width: 440px; }
      h1 { font-size: 24px; font-weight: 600; }
      p { line-height: 1.6; color: #525252; }
      a { display: inline-block; margin: 12px 0; color: inherit;
        padding: 10px 16px; border: 1px solid #d4d4d4; border-radius: 6px; }
      details { margin-top: 24px; color: #737373; font-size: 13px; }
      code { display: block; margin-top: 8px; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeDescription}</p>
      ${actionUrl ? `<a href="${actionUrl}">${actionLabel}</a>` : "<p>Return to Lobu to check the connection and start authorization again.</p>"}
      <details><summary>Technical details</summary><code>${safeError}</code></details>
    </main>
  </body>
</html>`;
}
