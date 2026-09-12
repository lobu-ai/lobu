import type { FeedReadResult, FeedReadWindow } from '@lobu/connector-sdk';
import {
  ATLASSIAN_JIRA_ISSUES_FEED_KEY,
  isAtlassianMcpConfig,
  normalizeMcpProxyConfig,
  readAtlassianMcpFeed,
} from '../operations/atlassian-mcp-feed';

export interface SourceFeedAdapterParams {
  organizationId: string;
  connectionId: number;
  connectorKey: string;
  feedKey: string;
  mcpConfig: Record<string, unknown> | null;
  feedConfig: Record<string, unknown>;
  connectionConfig: Record<string, unknown>;
  query?: string;
  cursor?: string;
  window?: FeedReadWindow;
  limit?: number;
  offset?: number;
  sort?: { column: string; order: 'asc' | 'desc' };
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface SourceFeedAdapter {
  matches(params: SourceFeedAdapterParams): boolean;
  read(params: SourceFeedAdapterParams): Promise<FeedReadResult>;
}

const atlassianMcpAdapter: SourceFeedAdapter = {
  matches: ({ mcpConfig }) => isAtlassianMcpConfig(mcpConfig),
  async read(params) {
    if (params.feedKey !== ATLASSIAN_JIRA_ISSUES_FEED_KEY) {
      throw new Error(
        `Atlassian MCP feed '${params.feedKey}' has no registered source-read adapter`
      );
    }
    const mcpConfig = normalizeMcpProxyConfig(params.mcpConfig!);
    if (!mcpConfig) throw new Error('Atlassian MCP source-read adapter is misconfigured');
    const storedQuery = typeof params.feedConfig.query === 'string'
      ? params.feedConfig.query
      : typeof params.feedConfig.jql === 'string'
        ? params.feedConfig.jql
        : '';
    return readAtlassianMcpFeed({
      organizationId: params.organizationId,
      connectionId: params.connectionId,
      connectorKey: params.connectorKey,
      mcpConfig,
      feedConfig: params.feedConfig,
      connectionConfig: params.connectionConfig,
      baseQuery: storedQuery,
      query: params.query,
      cursor: params.cursor,
      window: params.window,
      limit: params.limit,
      offset: params.offset,
      sort: params.sort,
      signal: params.signal,
      deadlineAt: params.deadlineAt,
    });
  },
};

const SOURCE_FEED_ADAPTERS: SourceFeedAdapter[] = [atlassianMcpAdapter];

/**
 * Try the metadata-backed source-read adapters in registration order. Compiled
 * and device connectors bypass this seam; adding another managed connector is
 * a registry entry, never a branch in the generic read path.
 */
export async function readSourceFeedFromAdapter(
  params: SourceFeedAdapterParams
): Promise<FeedReadResult | null> {
  const adapter = SOURCE_FEED_ADAPTERS.find((candidate) => candidate.matches(params));
  return adapter ? adapter.read(params) : null;
}
