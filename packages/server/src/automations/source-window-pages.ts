import { ToolUserError } from '../utils/errors';
import type { SourceWindowPage } from '../utils/jwt';

interface SourceProof {
  required_sources?: Array<{ name: string; feed_id: number }>;
  source_pages?: SourceWindowPage[];
}

/**
 * How far a completion read each pinned live source. Reading is the agent's
 * call, so a short or broken page chain is recorded rather than refused; only
 * receipts that do not belong to this Automation's pinned sources fail.
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
    const root = chain.find((page) => page.before_cursor == null);
    const visited = new Set<SourceWindowPage>();
    let rows = 0;
    let complete = false;
    for (let current = root; current && !visited.has(current); ) {
      visited.add(current);
      rows += current.returned;
      if (current.next_cursor == null) {
        complete = true;
        break;
      }
      const cursor = current.next_cursor;
      current = chain.find((page) => page.before_cursor === cursor);
    }
    return { ...source, axis: root?.axis ?? null, rows, complete };
  });
}
