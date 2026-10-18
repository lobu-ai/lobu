/**
 * Shared in-page handoff banner for browser-staged drafts.
 *
 * Two connectors stage text in the user's own signed-in page and stop before
 * submit (`x.prepare_reply`, `linkedin.prepare_comment`). Without a banner the
 * staged page is context-free — a draft in a box with no record of why the
 * agent thought the post mattered. Both banners are the same DOM shape (a
 * fixed `#lobu-handoff-banner` status node, anchored above the composer when
 * one is found, dismissible, never auto-submitted); only the title,
 * instruction line, optional footer, and composer/host selectors differ per
 * site. Callers pass those; this module owns the injection script.
 *
 * Pure (no `node:`, no `@lobu/core`): the root must stay loadable inside a V8
 * isolate.
 */

export function truncateHandoffReason(
  reason: string | undefined | null,
  maxLen = 120,
): string | undefined {
  if (reason == null) return undefined;
  const t = reason.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

export interface HandoffBannerOptions {
  reason?: string;
  /** Banner heading. Defaults to a neutral staged-draft title. */
  title?: string;
  /** Instruction line under the heading. Defaults to a never-submits line. */
  instruction?: string;
  /** Optional third line (e.g. where to record the outcome). Omit for none. */
  footer?: string;
  /** Composer selectors tried in order. Defaults to a generic textbox. */
  composerSelectors?: string[];
  /** `closest()` hosts tried in order before falling back to `parentElement`. */
  hostSelectors?: string[];
}

/**
 * JS expression: inject the Lobu handoff banner on the page.
 *
 * Best-effort; the host page re-renders aggressively and may drop the node.
 * Never fatal — the draft is already staged by the time this runs. No
 * auto-dismiss: the draft lives in the user's page, so its context should
 * still be present when the user returns later.
 */
export function buildInjectHandoffBannerExpression(
  opts: HandoffBannerOptions,
): string {
  const reason = truncateHandoffReason(opts.reason);
  const title = opts.title ?? "Lobu staged this draft";
  const instruction =
    opts.instruction ?? "Review the draft yourself — Lobu did not submit.";
  const titleLit = JSON.stringify(title);
  const instructionLit = JSON.stringify(instruction);
  const reasonLit = JSON.stringify(reason ?? null);
  const footerLit = JSON.stringify(opts.footer ?? null);
  const composerSelectorsLit = JSON.stringify(
    opts.composerSelectors ?? ['div[role="textbox"][contenteditable="true"]'],
  );
  const hostSelectorsLit = JSON.stringify(opts.hostSelectors ?? ["form"]);
  return `(async()=>{
  const TITLE = ${titleLit};
  const INSTRUCTION = ${instructionLit};
  const REASON = ${reasonLit};
  const FOOTER = ${footerLit};
  const COMPOSER_SELECTORS = ${composerSelectorsLit};
  const HOST_SELECTORS = ${hostSelectorsLit};
  const ID = 'lobu-handoff-banner';
  try {
    const prev = document.getElementById(ID);
    if (prev) prev.remove();
  } catch (_) {}

  const root = document.createElement('div');
  root.id = ID;
  root.setAttribute('role', 'status');
  root.setAttribute('data-lobu', 'handoff-banner');
  root.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483646',
    'max-width:min(520px,calc(100vw - 24px))',
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif',
    'color:#0f172a',
    'background:#fff',
    'border:1px solid #cbd5e1',
    'border-left:4px solid #0ea5e9',
    'border-radius:10px',
    'box-shadow:0 8px 28px rgba(15,23,42,.18)',
    'padding:10px 12px',
    'display:flex',
    'gap:10px',
    'align-items:flex-start',
    'pointer-events:auto',
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';

  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;margin:0 0 2px;color:#0c4a6e';
  head.textContent = TITLE;

  const line = document.createElement('div');
  line.style.cssText = 'color:#334155;margin:0 0 2px';
  line.textContent = INSTRUCTION;

  body.appendChild(head);
  body.appendChild(line);

  if (REASON) {
    const why = document.createElement('div');
    why.style.cssText = 'color:#64748b;margin:4px 0 0;font-size:12px';
    why.textContent = 'Why: ' + REASON;
    body.appendChild(why);
  }

  if (FOOTER) {
    const foot = document.createElement('div');
    foot.style.cssText = 'color:#64748b;margin:4px 0 0;font-size:12px';
    foot.textContent = FOOTER;
    body.appendChild(foot);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '\\u00d7';
  close.style.cssText = [
    'flex:none',
    'border:0',
    'background:transparent',
    'color:#64748b',
    'font:20px/1 sans-serif',
    'cursor:pointer',
    'padding:0 2px',
  ].join(';');
  close.onclick = function () { try { root.remove(); } catch (_) {} };

  root.appendChild(body);
  root.appendChild(close);

  // Anchor above the composer when we can find it, so the reason sits
  // next to the draft instead of floating over unrelated content.
  let anchored = false;
  try {
    let composer = null;
    for (const selector of COMPOSER_SELECTORS) {
      try {
        composer = document.querySelector(selector);
      } catch (_) {
        composer = null;
      }
      if (composer) break;
    }
    if (composer) {
      let host = null;
      for (const selector of HOST_SELECTORS) {
        try {
          host = composer.closest(selector);
        } catch (_) {
          host = null;
        }
        if (host) break;
      }
      host = host || composer.parentElement;
      if (host && host.parentElement) {
        root.style.position = 'relative';
        root.style.top = '0';
        root.style.left = '0';
        root.style.transform = 'none';
        root.style.margin = '8px 0 12px';
        root.style.maxWidth = '100%';
        host.parentElement.insertBefore(root, host);
        anchored = true;
      }
    }
  } catch (_) {}

  if (!anchored) {
    (document.body || document.documentElement).appendChild(root);
  }

  // No auto-dismiss: the draft lives in the user's page, so its context should
  // still be present when the user returns later. The dismiss button remains.

  return { ok: true, anchored: anchored, has_reason: !!REASON };
})()`;
}
