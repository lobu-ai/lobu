/** Upgrade the example's existing, account-bound browser reader. */
export function expandXTimelineReader(script: string): string {
  const marker = "/* social-x-fifty-v1 */";
  if (script.includes(marker)) return script;
  const candidates = [
    ...script.matchAll(/expression:("(?:[^"\\]|\\.)*")/g),
  ].filter((match) => {
    const expression = JSON.parse(match[1]) as string;
    return (
      expression.startsWith("({timeline:") && expression.includes("posts:")
    );
  });
  const oldCoverage = "coverage:'First loaded page only; no scrolling'";
  const connectionIds = new Set(
    [...script.matchAll(/connection_id:(\d+)/g)].map((match) => match[1])
  );
  const expectedProfile = script.match(
    /identity\?\.profile!==('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/
  )?.[1];
  const policyKeys = "'navigate','evaluate','close_tab'";
  if (
    candidates.length !== 1 ||
    !script.includes(oldCoverage) ||
    connectionIds.size !== 1 ||
    !expectedProfile ||
    !script.includes("let identity;") ||
    !script.includes(policyKeys)
  )
    throw new Error(
      "X reader shape changed; inspect it before expanding coverage"
    );
  const match = candidates[0];
  const snapshot = JSON.parse(match[1]) as string;
  // Keep the existing DOM projection and outer identity, policy, receipt,
  // dedupe and scratch-tab cleanup checks. All collected bodies stay inside
  // one browser evaluate receipt, including rows removed by virtualization.
  const expression = `(async () => {
    ${marker}
    const read = () => ${snapshot};
    const profile = () => document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    const account = ${expectedProfile};
    const posts = new Map();
    const started = Date.now();
    let stale = 0, scrolls = 0, reason = 'scroll budget';
    let data;
    for (let pass = 0; pass <= 45; pass++) {
      if (location.origin !== 'https://x.com' || location.pathname !== '/home' || profile() !== account)
        throw new Error('X account or page changed during read');
      data = read();
      if (!data.timeline?.includes('Following')) throw new Error('X timeline changed during read');
      const before = posts.size;
      for (const post of data.posts || []) {
        if (post.text && /^https:\\/\\/x\\.com\\/[A-Za-z0-9_]+\\/status\\/\\d+$/.test(post.url)) posts.set(post.url, post);
        if (posts.size >= 50) break;
      }
      if (posts.size >= 50) { reason = 'target reached'; break; }
      stale = posts.size === before ? stale + 1 : 0;
      if (stale >= 4) { reason = 'stalled'; break; }
      if (Date.now() - started >= 24000) { reason = 'time budget'; break; }
      if (pass === 45) break;
      window.scrollBy(0, Math.max(600, innerHeight * 0.85));
      scrolls++;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { ...data, posts: [...posts.values()], coverage: reason + '; ' + scrolls + ' scrolls; text only, replies/media not inspected' };
  })()`;
  return script
    .replace(match[0], () => `expression:${JSON.stringify(expression)}`)
    .replace(policyKeys, `${policyKeys},'focus_tab'`)
    .replace(
      "let identity;",
      () =>
        `{ const focused = await client.operations.execute({connection_id:${[...connectionIds][0]},operation_key:'focus_tab',input:{tab_id:tab,draw_attention:false}}); if (focused.status !== 'completed') throw new Error('X scratch tab focus did not complete'); } let identity;`
    )
    .replace(oldCoverage, "coverage:data.coverage");
}
