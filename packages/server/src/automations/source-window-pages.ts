import { ToolUserError } from '../utils/errors';
import type { SourceWindowPage } from '../utils/jwt';

interface SourceProof {
  required_sources?: Array<{ name: string; feed_id: number }>;
  source_pages?: SourceWindowPage[];
}

/**
 * The unambiguous, contiguous prefix read from each pinned live source.
 * Reading is the agent's call, so short or broken chains are recorded rather
 * than refused. Receipts must still match this Automation's pinned sources.
 */
export function summarizeSourceWindowPages(
  tokens: SourceProof[],
  required: Array<{ name: string; feed_id: number }>,
): Array<{ name: string; feed_id: number; axis: string | null; rows: number; complete: boolean }> {
  const roster = (sources: typeof required) => JSON.stringify(
    [...sources].sort((a, b) => a.name.localeCompare(b.name)),
  );
  const expected = roster(required);
  const pages = tokens.flatMap((token) => token.source_pages ?? []);
  const fail = (message: string): never => {
    throw new ToolUserError(`Invalid Automation source window: ${message}`, 409);
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
    const root = roots.length === 1 ? roots[0] : undefined;
    const visited = new Set<SourceWindowPage>();
    let rows = 0;
    let complete = false;
    for (let current = root; current && !visited.has(current); ) {
      if (current.axis !== root?.axis || current.revision !== root?.revision) break;
      visited.add(current);
      rows += current.returned;
      if (current.next_cursor == null) {
        complete = visited.size === chain.length;
        break;
      }
      const cursor = current.next_cursor;
      const next = chain.filter((page) => page.before_cursor === cursor);
      current = next.length === 1 ? next[0] : undefined;
    }
    return { ...source, axis: root?.axis ?? null, rows, complete };
  });
}
