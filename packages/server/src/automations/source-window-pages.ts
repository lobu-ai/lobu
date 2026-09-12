import { ToolUserError } from '../utils/errors';
import type { SourceWindowPage } from '../utils/jwt';

interface SourceProof {
  required_sources?: Array<{ name: string; feed_id: number }>;
  source_pages?: SourceWindowPage[];
}

/** Same completion proof as event pages, independently for every declared live source. */
export function assertCompleteSourceWindowPages(
  tokens: SourceProof[],
  required: Array<{ name: string; feed_id: number }>,
): Array<{ name: string; feed_id: number; axis: string; rows: number }> {
  const roster = (sources: typeof required) => JSON.stringify(
    [...sources].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const expected = roster(required);
  const pages = tokens.flatMap((token) => token.source_pages ?? []);
  const fail = (message: string): never => {
    throw new ToolUserError(`Incomplete Automation source window: ${message}`, 409);
  };
  if (tokens.some((token) => roster(token.required_sources ?? []) !== expected)) {
    fail('source receipts do not match the pinned Automation sources.');
  }
  if (pages.some((page) => !required.some((source) => source.name === page.name && source.feed_id === page.feed_id))) {
    fail('unexpected source receipt.');
  }
  return required.map((source) => {
    const chain = pages.filter((page) => page.name === source.name);
    const roots = chain.filter((page) => page.before_cursor == null);
    if (roots.length !== 1) fail(`${source.name} requires exactly one first page.`);
    const root = roots[0];
    if (chain.some((page) => page.feed_id !== root.feed_id || page.axis !== root.axis || page.revision !== root.revision)) {
      fail(`${source.name} changed its source request during pagination.`);
    }
    const visited = new Set<SourceWindowPage>();
    let current = root;
    let rows = 0;
    while (true) {
      if (visited.has(current)) fail(`${source.name} has a cyclic page chain.`);
      visited.add(current);
      rows += current.returned;
      if (current.next_cursor == null) break;
      const next = chain.filter((page) => page.before_cursor === current.next_cursor);
      if (next.length !== 1) fail(`${source.name} has missing or duplicate pages. Continue its sources_page cursor and retain every window_token.`);
      current = next[0];
    }
    if (visited.size !== chain.length) fail(`${source.name} has disconnected or duplicate pages.`);
    return { ...source, axis: root.axis, rows };
  });
}
