import type { ChromeActionDispatcher } from "@lobu/connector-sdk";

const origins = ["linkedin.com", "*.linkedin.com"];

/** The selector is deliberately limited to the observed top-level post button;
 * reaction buttons inside comment containers are excluded.
 */
export function buildLinkedInLikeExpression(
  postUrl: string,
  desired: boolean | null
): string {
  return String.raw`(async () => {
    const expected = new URL(${JSON.stringify(postUrl)});
    const desired = ${JSON.stringify(desired)};
    const assertPage = () => {
      if (location.origin !== expected.origin || location.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, ''))
        throw new Error('LinkedIn post changed; refusing to react');
    };
    const read = () => {
      assertPage();
      const buttons = [...document.querySelectorAll('main button[aria-label^="Reaction button state:"], [role="main"] button[aria-label^="Reaction button state:"]')]
        .filter(b => b.getClientRects().length && !b.closest('[id^="replaceableComment_"], [componentkey^="commentsSectionContainer"], .comments-comment-item'));
      if (buttons.length > 1) throw new Error('LinkedIn post reaction control is ambiguous');
      if (!buttons.length) return null;
      const button = buttons[0];
      const label = button.getAttribute('aria-label').slice('Reaction button state:'.length).trim().toLowerCase();
      if (label !== 'no reaction' && label !== 'like') throw new Error('Preserving an existing or unknown LinkedIn reaction: ' + label);
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') throw new Error('LinkedIn reaction control is disabled');
      return { button, liked: label === 'like' };
    };
    const wait = async (test) => {
      for (let i = 0; i < 40; i++) {
        const result = read();
        if (result && test(result)) return result;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('LinkedIn reaction state could not be verified');
    };
    const before = await wait(() => true);
    const changed = desired !== null && before.liked !== desired;
    if (changed) {
      assertPage();
      before.button.click();
      await wait(state => state.liked === desired);
    }
    const after = read();
    if (!after) throw new Error('LinkedIn reaction control disappeared');
    return { liked: after.liked, changed, post_url: expected.href };
  })()`;
}

export async function setLinkedInLike(
  browser: ChromeActionDispatcher,
  postUrl: string,
  liked: boolean
): Promise<{
  post_url: string;
  liked: boolean;
  changed: boolean;
  verified: true;
}> {
  let tabId: number | undefined;
  try {
    const nav = await browser.dispatch<{ tab_id?: number }>("navigate", {
      url: postUrl,
      new_tab: true,
      wait_for_load: true,
      allowed_origins: origins,
    });
    tabId = nav.tab_id;
    if (typeof tabId !== "number")
      throw new Error("LinkedIn scratch tab was not created");
    const read = async (desired: boolean | null) => {
      const result = await browser.dispatch<{
        value?: { liked: boolean; changed: boolean; post_url: string };
      }>("evaluate", {
        tab_id: tabId,
        expression: buildLinkedInLikeExpression(postUrl, desired),
        allowed_origins: origins,
      });
      if (
        !result.value ||
        result.value.post_url !== postUrl ||
        typeof result.value.liked !== "boolean"
      )
        throw new Error("LinkedIn returned no verified reaction state");
      return result.value;
    };
    const effect = await read(liked);
    // A second navigation reads server-backed state, including on a retry that
    // already matches. Never toggle again after an uncertain write result.
    await browser.dispatch("navigate", {
      url: postUrl,
      tab_id: tabId,
      wait_for_load: true,
      allowed_origins: origins,
    });
    const persisted = await read(null);
    if (persisted.liked !== liked)
      throw new Error("LinkedIn like state did not persist after reload");
    return {
      post_url: postUrl,
      liked,
      changed: effect.changed,
      verified: true,
    };
  } finally {
    if (typeof tabId === "number")
      await browser.dispatch("close_tab", {
        tab_id: tabId,
        allowed_origins: origins,
      });
  }
}
