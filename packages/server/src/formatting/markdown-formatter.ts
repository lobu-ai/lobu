/**
 * Markdown Formatter for MCP Tool Results
 *
 * Converts structured tool results into readable markdown format
 * for better display in Claude Desktop/Code.
 * Includes content formatting with proper thread hierarchy (Reddit/HN/X style).
 */

import { SAVE_MEMORY_RENDER_PAYLOAD_KEYS } from '../tools/save_content.js';
import type { Entity } from '../tools/search.js';

// ============================================
// Content Formatter (thread-based markdown)
// ============================================

/**
 * Content structure (subset of fields needed for formatting)
 */
interface FormattableContent {
  id: number;
  platform: string;
  author_name: string | null;
  client_name?: string | null;
  title: string | null;
  text_content: string;
  source_url: string | null;
  score: number;
  occurred_at: string;
  classifications?: Record<
    string,
    {
      values?: string[];
      source?: string;
    }
  >;
  // Thread metadata
  origin_parent_id: string | null;
  root_origin_id: string;
  depth: number;
  parent_context?: {
    author_name: string;
    title: string | null;
    text_content: string;
    occurred_at: string;
    source_url: string;
    score: number;
  } | null;
}

/**
 * Thread group containing root and nested replies
 */
interface ThreadGroup {
  rootId: string;
  title: string | null;
  items: FormattableContent[];
}

/**
 * Formatting options for content markdown
 */
interface ContentFormatOptions {
  /** Include classification badges after content (default: true) */
  includeClassifications?: boolean;
  /** Include URLs (default: true for MCP, false for LLM prompts) */
  includeUrls?: boolean;
  /** Max content length before truncation (default: 300) */
  maxContentLength?: number;
  /** Include score in metadata line (default: true) */
  includeScore?: boolean;
}

const DEFAULT_CONTENT_FORMAT_OPTIONS: Required<ContentFormatOptions> = {
  includeClassifications: true,
  includeUrls: true,
  maxContentLength: 300,
  includeScore: true,
};

/**
 * Group content by thread (root_origin_id) and sort by hierarchy
 */
function groupContentByThread(items: FormattableContent[]): ThreadGroup[] {
  const threadMap = new Map<string, FormattableContent[]>();

  for (const item of items) {
    const rootId = item.root_origin_id || item.id.toString();
    const group = threadMap.get(rootId);
    if (group) {
      group.push(item);
    } else {
      threadMap.set(rootId, [item]);
    }
  }

  const threads: ThreadGroup[] = [];

  for (const [rootId, threadItems] of threadMap.entries()) {
    threadItems.sort((a, b) => {
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime();
    });

    const root = threadItems.find((f) => f.depth === 0);
    const title = root?.title || threadItems[0]?.title || null;

    threads.push({
      rootId,
      title,
      items: threadItems,
    });
  }

  // Sort threads by earliest item date (newest first)
  threads.sort((a, b) => {
    const aDate = new Date(a.items[0]?.occurred_at || 0).getTime();
    const bDate = new Date(b.items[0]?.occurred_at || 0).getTime();
    return bDate - aDate;
  });

  return threads;
}

/**
 * Format content as markdown with proper thread hierarchy
 */
function formatContentAsMarkdown(
  items: FormattableContent[],
  options?: ContentFormatOptions
): string {
  const opts = { ...DEFAULT_CONTENT_FORMAT_OPTIONS, ...options };

  if (items.length === 0) {
    return '*No events found.*';
  }

  const threads = groupContentByThread(items);
  const parts: string[] = [];

  for (const thread of threads) {
    parts.push(formatThread(thread, opts));
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Format a single thread
 */
function formatThread(thread: ThreadGroup, opts: Required<ContentFormatOptions>): string {
  const lines: string[] = [];

  const title = thread.title || 'Untitled Thread';
  lines.push(`## Thread: ${title}`);

  for (const item of thread.items) {
    lines.push(formatContentItem(item, opts));
  }

  return lines.join('\n');
}

/**
 * Format a single content item
 */
function formatContentItem(item: FormattableContent, opts: Required<ContentFormatOptions>): string {
  const lines: string[] = [];
  const indent = '  '.repeat(item.depth);

  const isRoot = item.depth === 0;
  const label = isRoot ? '**Root**' : '**Reply**';

  const author = item.author_name || (item.client_name ? `via ${item.client_name}` : 'Anonymous');
  const date = formatDate(item.occurred_at);
  let metaLine = `${indent}[ID: ${item.id}] ${label} by ${author} • ${item.platform} • ${date}`;

  if (opts.includeScore) {
    metaLine += ` • Score: ${item.score.toFixed(2)}`;
  }

  lines.push(metaLine);

  if (item.parent_context && item.depth > 0) {
    const pc = item.parent_context;
    const parentAuthor = pc.author_name || 'Anonymous';
    const parentExcerpt = truncateContent(pc.text_content || pc.title || '', 100);
    lines.push(`${indent}*↳ Replying to ${parentAuthor}: "${parentExcerpt}"*`);
  }

  const content = truncateContent(item.text_content || item.title || '', opts.maxContentLength);
  if (content) {
    const quotedContent = content
      .split('\n')
      .map((line) => `${indent}> ${line}`)
      .join('\n');
    lines.push(quotedContent);
  }

  if (opts.includeClassifications && item.classifications) {
    const badges = formatClassificationBadges(item.classifications);
    if (badges) {
      lines.push(`${indent}${badges}`);
    }
  }

  if (opts.includeUrls && item.source_url) {
    lines.push(`${indent}${item.source_url}`);
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Format classification badges as [value] [value2] style
 */
function formatClassificationBadges(
  classifications: Record<string, { values?: string[]; source?: string }>
): string {
  const badges: string[] = [];

  for (const [_slug, data] of Object.entries(classifications)) {
    if (data.values && data.values.length > 0) {
      for (const value of data.values) {
        badges.push(`[${value}]`);
      }
    }
  }

  return badges.join(' ');
}

/**
 * Truncate content to max length, preserving word boundaries
 */
function truncateContent(content: string, maxLength: number): string {
  if (!content) return '';

  const cleaned = content.replace(/\s+/g, ' ').trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const truncated = cleaned.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.7) {
    return `${truncated.substring(0, lastSpace)}...`;
  }

  return `${truncated}...`;
}

/**
 * Format date as short human-readable string
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    });
  } catch {
    return dateStr;
  }
}

// ============================================
// MCP Tool Result Formatters
// ============================================

interface FormatterOptions {
  includeRawJson?: boolean; // Include raw JSON at the end
  compact?: boolean; // More compact formatting
}

/**
 * Format any tool result as markdown
 */
export function formatToolResult(
  toolName: string,
  result: any,
  options: FormatterOptions = {}
): string {
  const formatters: Record<string, (result: any, options: FormatterOptions) => string> = {
    search_memory: formatSearchResult,
    save_memory: formatSaveMemoryResult,
    get_automation: formatGetAutomationResult,
    read_knowledge: formatGetContentResult,
    manage_automations: formatManageAutomationsResult,
    query_sql: formatQuerySqlResult,
    get_approval: formatLobuViewResult,
  };

  const formatter = formatters[toolName];
  if (formatter) {
    const markdown = formatter(result, options);

    // Optionally append raw JSON
    if (options.includeRawJson) {
      return `${markdown}\n\n---\n\n<details>\n<summary>Raw JSON</summary>\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n</details>`;
    }

    return markdown;
  }

  // Fallback: pretty-print JSON
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

function formatSaveMemoryResult(result: Record<string, unknown>): string {
  // The App card reads these fields off structuredContent, which carries them
  // already. Keep the text fallback as the compact receipt save_memory returned
  // before it gained an inline App, otherwise a large note or template is
  // echoed twice to the model (once here and once in structuredContent).
  const receipt = { ...result };
  for (const key of SAVE_MEMORY_RENDER_PAYLOAD_KEYS) {
    delete receipt[key];
  }
  return `\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\``;
}

function escapeLobuViewMarkdown(value: unknown, singleLine = false): string {
  const text = String(value ?? '');
  const normalized = singleLine ? text.replace(/\s+/g, ' ').trim() : text;
  return normalized.replace(/([\\`*_[\]{}<>()#+\-.!|])/g, '\\$1');
}

function formatLobuViewCode(value: unknown): string {
  const code = String(value ?? '');
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${code}\n${fence}`;
}

function safeLobuViewLink(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return null;
  }
}

function formatLobuViewResult(result: any): string {
  let markdown = result.title ? `## ${escapeLobuViewMarkdown(result.title, true)}\n\n` : '';
  for (const block of result.blocks ?? []) {
    if (block.type === 'text') {
      markdown += `${
        block.label ? `**${escapeLobuViewMarkdown(block.label, true)}**\n\n` : ''
      }${escapeLobuViewMarkdown(block.value)}\n\n`;
    } else if (block.type === 'code') {
      markdown += `${formatLobuViewCode(block.value)}\n\n`;
    } else if (block.type === 'diff') {
      for (const field of block.fields ?? []) {
        markdown += `- **${escapeLobuViewMarkdown(field.label, true)}**: ${
          field.before === undefined
            ? escapeLobuViewMarkdown(field.after, true)
            : `${escapeLobuViewMarkdown(field.before || '—', true)} → ${escapeLobuViewMarkdown(
                field.after || '—',
                true
              )}`
        }\n`;
      }
      markdown += '\n';
    }
  }
  for (const action of result.actions ?? []) {
    const href = safeLobuViewLink(action.href);
    if (href) markdown += `[${escapeLobuViewMarkdown(action.label, true)}](${href})\n\n`;
  }
  return markdown.trim() || 'Lobu view rendered.';
}

/**
 * Format unified search result
 */
function formatSearchResult(result: any, options: FormatterOptions): string {
  const { entity, matches, suggestion } = result;
  const hasContent = result.content?.length > 0;
  const hasConversation = result.conversation_messages?.length > 0;

  let md: string;

  if (!entity && matches.length === 0 && (hasContent || hasConversation)) {
    // Recall hits with no entity match — don't claim "No Results"; the content
    // and channel-conversation sections appended below carry the answer.
    md = '# 🔍 Search Results\n\n';
  } else if (!entity && matches.length === 0) {
    md = `# ❌ No Results Found\n\n${suggestion || 'No matching entities found.'}\n\n`;
  } else if (entity?.parent_id != null) {
    md = formatSearchChildEntityResult(
      {
        matches,
        selected: entity,
        metadata: result.metadata,
      },
      options
    );
  } else {
    md = formatSearchRootEntityResult(
      {
        matches,
        selected: entity,
        created: false,
        suggestion,
        metadata: result.metadata,
        feed_candidates: {
          existing: result.feeds || [],
          discovered: {},
          status: 'complete',
        },
      },
      options
    );
  }

  // Append recall sources if present.
  if (hasContent) {
    md += formatContentSnippets(result.content);
  }
  if (hasConversation) {
    md += formatConversationMessages(result.conversation_messages);
  }
  if (result.coverage) {
    md += formatSearchCoverage(result.coverage);
  }
  return md;
}

function formatSearchCoverage(coverage: any): string {
  const localSources = Array.isArray(coverage.local_sources) ? coverage.local_sources : [];
  const sourceFeeds = Array.isArray(coverage.source_feeds) ? coverage.source_feeds : [];
  const workspaces = Array.isArray(coverage.workspaces) ? coverage.workspaces : [];
  let md = '## Search Coverage\n\n';
  if (coverage.scope) md += `Scope: ${coverage.scope}. Status: ${coverage.status ?? 'complete'}.\n\n`;
  if (workspaces.length > 0) {
    md += 'Workspace coverage:\n\n';
    for (const workspace of workspaces) {
      md += `- \`${workspace.workspace_slug}\`: ${workspace.status}\n`;
    }
    md += '\n';
  } else if (coverage.workspace_slug) {
    md += `Workspace: \`${coverage.workspace_slug}\`.\n\n`;
  }
  md += `Local stores searched: ${localSources.length > 0 ? localSources.join(', ') : 'none completed'}.\n\n`;
  if (coverage.source_feed_discovery === 'unavailable') {
    md += 'Source feed discovery was unavailable for this search.\n\n';
    return md;
  }
  if (sourceFeeds.length === 0) {
    md += 'No accessible source-backed feeds were found.\n\n';
    return md;
  }
  md += 'Connected source feeds were not queried. Use `client.feeds.readMany` through `query_sdk` to read selected sources explicitly.\n\n';
  md += 'Accessible source feeds:\n\n';
  for (const feed of sourceFeeds) {
    const label = `${feed.connection_slug}/${feed.feed_key}`;
    const displayName = feed.display_name ? ` (${feed.display_name})` : '';
    const workspace = feed.workspace_slug ? `, workspace \`${feed.workspace_slug}\`` : '';
    md += `- Feed ${feed.feed_id}: \`${label}\`${displayName}, ${feed.connector_key}${workspace}, not queried\n`;
  }
  if (coverage.more_source_feeds) md += '- More accessible source feeds are available\n';
  return `${md}\n`;
}

/** Render channel-conversation recall hits (`channel_messages`) — keeps default
 * (non-JSON) MCP clients from seeing "No Results" when search_memory matched
 * only past channel conversation. */
function formatConversationMessages(messages: any[]): string {
  let md = `## Channel Conversation (${messages.length})\n\n`;
  for (const m of messages) {
    const who = m.author_name || 'unknown';
    const where = m.channel_id ? ` in #${m.channel_id}` : '';
    const when = m.occurred_at ? ` · ${new Date(m.occurred_at).toLocaleString()}` : '';
    const workspace = m.workspace_slug ? ` · workspace \`${m.workspace_slug}\`` : '';
    md += `**${who}**${where}${when}${workspace}\n`;
    const text = m.text || '';
    const excerpt = text.length > 300 ? `${text.slice(0, 300)}...` : text;
    if (excerpt) md += `> ${excerpt.replace(/\n/g, '\n> ')}\n\n`;
  }
  return md;
}

function formatContentSnippets(content: any[]): string {
  let md = `## Related Content (${content.length})\n\n`;

  for (const item of content) {
    const title = item.title || '(untitled)';
    const sim =
      item.similarity != null ? ` (similarity: ${Number(item.similarity).toFixed(2)})` : '';

    md += `### ${title}${sim}\n`;
    if (item.platform) md += `**Platform**: ${item.platform}`;
    if (item.author_name) md += ` | **Author**: ${item.author_name}`;
    if (item.occurred_at) md += ` | **Date**: ${new Date(item.occurred_at).toLocaleDateString()}`;
    md += '\n\n';
    if (item.id != null) md += `**Lobu event ID**: ${item.id}\n\n`;
    const workspaceSlugs = Array.isArray(item.workspace_slugs)
      ? item.workspace_slugs
      : item.workspace_slug
        ? [item.workspace_slug]
        : [];
    if (workspaceSlugs.length > 0) {
      md += `**Visible through workspace${workspaceSlugs.length === 1 ? '' : 's'}**: ${workspaceSlugs
        .map((slug: string) => `\`${slug}\``)
        .join(', ')}\n\n`;
    }

    const text = item.text_content || '';
    const excerpt = text.length > 300 ? text.slice(0, 300) + '...' : text;
    if (excerpt) md += `> ${excerpt.replace(/\n/g, '\n> ')}\n\n`;

    if (item.source_url) md += `[View source](${item.source_url})\n\n`;
  }

  return md;
}

/**
 * Format search results for root entities
 */
function formatSearchRootEntityResult(result: any, _options: FormatterOptions): string {
  const { matches, created, selected, scheduled_feeds, feed_candidates, suggestion, metadata } =
    result;

  let md = '';

  // Header
  if (created) {
    md += '# ✅ Entity Created\n\n';
  } else if (matches.length > 0) {
    md += '# 🔍 Search Results\n\n';
  } else {
    md += '# ❌ No Results Found\n\n';

    // Show feed candidates if present
    if (feed_candidates) {
      md += formatFeedCandidates(feed_candidates);
    }

    // Show suggestion text
    if (suggestion) {
      md += `## 💡 Next Steps\n\n${suggestion}\n\n`;
    }

    if (metadata?.feed_discovery) {
      md += formatFeedDiscovery(metadata.feed_discovery);
    }
    return md;
  }

  // Selected entity (most relevant)
  if (selected) {
    md += '## Selected Entity\n\n';
    md += formatEntityCard(selected);
    md += '\n\n';

    // Show active feeds for the selected entity
    if (
      feed_candidates?.existing &&
      Array.isArray(feed_candidates.existing) &&
      feed_candidates.existing.length > 0
    ) {
      md += `## 🤖 Active Feeds (${feed_candidates.existing.length})\n\n`;
      md += formatTable(feed_candidates.existing, {
        excludeFields: ['config', 'checkpoint'], // Too verbose for summary view
        fieldOrder: [
          'feed_id',
          'type',
          'status',
          'content_count',
          'sync_count',
          'last_sync_at',
          'next_run_at',
        ],
        formatters: {
          status: (val) => {
            const statusIcon = val === 'active' ? '✅' : val === 'in_review' ? '⏳' : '⏸️';
            return `${statusIcon} ${val}`;
          },
        },
      });
    }

    // Show suggestion text
    if (suggestion) {
      md += `## 💡 Suggestion\n\n${suggestion}\n\n`;
    }
  }

  // Additional matches
  if (matches.length > 1) {
    md += `## Other Matches (${matches.length - 1})\n\n`;
    matches.slice(1).forEach((match: Entity, idx: number) => {
      md += `### ${idx + 2}. ${match.name}\n\n`;
      md += formatEntityCard(match);
      md += '\n\n';
    });
  }

  // Discovered feeds
  if (scheduled_feeds && scheduled_feeds.length > 0) {
    md += `## 🤖 Discovered Feeds (${scheduled_feeds.length})\n\n`;
    md += '| Type | Status | Confidence | URL |\n';
    md += '|------|--------|------------|-----|\n';
    scheduled_feeds.forEach((feed: any) => {
      const statusIcon = feed.status === 'active' ? '✅' : '⏳';
      const url = feed.url || 'N/A';
      const urlShort = url.length > 50 ? `${url.substring(0, 47)}...` : url;
      md += `| ${feed.type} | ${statusIcon} ${feed.status} | ${feed.confidence}% | ${urlShort} |\n`;
    });
    md += '\n';
  }

  // Feed discovery metadata
  if (metadata?.feed_discovery) {
    md += formatFeedDiscovery(metadata.feed_discovery);
  }

  return md;
}

/**
 * Format feed candidates
 */
function formatFeedCandidates(candidates: Record<string, any[]>): string {
  let md = '## 🤖 Feed Candidates\n\n';

  const platforms = Object.entries(candidates).filter(
    ([_, results]) => Array.isArray(results) && results.length > 0
  );

  if (platforms.length === 0) {
    md += 'No feed candidates found.\n\n';
    return md;
  }

  platforms.forEach(([platform, results]) => {
    md += `### ${platform.charAt(0).toUpperCase() + platform.slice(1)} (${results.length})\n\n`;

    results.slice(0, 5).forEach((result, idx) => {
      md += `${idx + 1}. `;

      // Platform-specific formatting
      if (result.title || result.name) {
        md += `**${result.title || result.name}**`;
      }

      if (result.url) {
        md += ` - ${result.url}`;
      }

      if (result.subscribers) {
        md += ` (${result.subscribers.toLocaleString()} subscribers)`;
      }

      if (result.reviews) {
        md += ` (${result.reviews.toLocaleString()} reviews)`;
      }

      if (result.rating) {
        md += ` ⭐ ${result.rating}/5`;
      }

      md += '\n';
    });

    if (results.length > 5) {
      md += `\n_...and ${results.length - 5} more_\n`;
    }

    md += '\n';
  });

  return md;
}

/**
 * Format feed discovery metadata
 */
function formatFeedDiscovery(discovery: any): string {
  let md = '## 🔎 Feed Discovery\n\n';
  md += `- **Platforms searched**: ${discovery.platforms_searched.length} (${discovery.platforms_searched.join(', ')})\n`;
  md += `- **Platforms with results**: ${discovery.platforms_with_results.length}`;
  if (discovery.platforms_with_results.length > 0) {
    md += ` (${discovery.platforms_with_results.join(', ')})`;
  }
  md += '\n';
  md += `- **Total candidates**: ${discovery.total_candidates}\n`;
  if (discovery.error_message) {
    md += `- ⚠️ ${discovery.error_message}\n`;
  }
  md += '\n';
  return md;
}

/**
 * Format a single entity as a card
 */
function formatEntityCard(entity: Entity): string {
  let card = '';
  const isRootEntity = entity.parent_id == null;

  card += `**Entity ID**: \`${entity.id}\`\n\n`;
  const workspaceSlug = entity.workspace_slug ?? entity.organization_slug;
  if (workspaceSlug) card += `**Workspace**: \`${workspaceSlug}\`\n\n`;

  // Show parent info for child entities
  if (!isRootEntity && entity.parent_name) {
    card += `**Parent**: ${entity.parent_name} (ID: ${entity.parent_id})\n\n`;
  }

  const meta = entity.metadata ?? {};
  if (meta.domain) {
    card += `🌐 **Domain**: ${meta.domain}\n\n`;
  }

  const details = [];
  if (meta.category) details.push(`Category: ${meta.category}`);
  if (meta.platform_type) details.push(`Type: ${meta.platform_type}`);
  if (meta.main_market) details.push(`Market: ${meta.main_market}`);
  if (meta.market) details.push(`Market: ${meta.market}`);
  if (meta.link) details.push(`Link: ${meta.link}`);

  if (details.length > 0) {
    card += '**Details**: ';
    card += details.join(' • ');
    card += '\n\n';
  }

  // Stats
  const stats = entity.stats;
  const activeConnections =
    (stats as { active_connection_count?: number }).active_connection_count ?? 0;
  const connectionCount = (stats as { connection_count?: number }).connection_count ?? 0;
  card += '**Stats**: ';
  card += `📝 ${stats.content_count} content • `;
  card += `🔌 ${activeConnections}/${connectionCount} connectors`;
  if (isRootEntity) {
    card += ` • 📦 ${stats.children_count} children`;
  }
  card += '\n\n';

  card += `**Match**: ${entity.match_reason} (score: ${Number(entity.match_score).toFixed(2)})\n`;

  return card;
}

/**
 * Format search results for child entities
 */
function formatSearchChildEntityResult(result: any, _options: FormatterOptions): string {
  const { matches, selected } = result;

  let md = '';

  if (matches.length > 0) {
    md += '# 🔍 Search Results\n\n';
  } else {
    md += '# ❌ No Results Found\n\n';
    return md;
  }

  if (selected) {
    md += formatEntityCard(selected);
  } else {
    matches.forEach((match: Entity, idx: number) => {
      md += `## ${idx + 1}. ${match.name}\n\n`;
      md += formatEntityCard(match);
      md += '\n\n';
    });
  }

  return md;
}

/**
 * Format get_automation result (window-based)
 */
function formatGetAutomationResult(result: any, _options: FormatterOptions): string {
  const { windows, warnings, pending_analysis, automation } = result;

  // No windows found - show diagnostic info
  if (!windows || windows.length === 0) {
    let md = '# ℹ️ No Automation Windows Available\n\n';

    if (warnings && warnings.length > 0) {
      md += '## ⚠️ Warnings\n\n';
      warnings.forEach((warning: string) => {
        md += `- ${warning}\n`;
      });
      md += '\n';
    }

    return md;
  }

  // Windows found - show Automations
  let md = `# 📊 Automation Windows (${windows.length})\n\n`;

  windows.forEach((window: any, idx: number) => {
    md += `## ${idx + 1}. ${window.automation_name}\n\n`;

    md += `**Window**: ${new Date(window.window_start).toLocaleDateString()} - ${new Date(window.window_end).toLocaleDateString()}  \n`;
    md += `**Content Analyzed**: ${window.content_analyzed}  \n`;
    md += `**Model**: ${window.model_used}  \n`;
    md += `**Execution Time**: ${window.execution_time_ms}ms\n\n`;

    // Extracted data
    if (window.extracted_data) {
      md += '### 📈 Analysis Results\n\n';
      md += formatExtractedData(window.extracted_data);
      md += '\n\n';
    }

    md += '---\n\n';
  });

  if (pending_analysis?.unprocessed_ranges?.length > 0) {
    md += formatUnprocessedRanges(pending_analysis.unprocessed_ranges, automation?.automation_id);
  }

  return md;
}

/**
 * Explain the arrivals an explicitly requested later range leaves unclaimed.
 *
 * Silent unless something actually was skipped, which never happens on an
 * ordinary read — that one starts at the Automation's arrival mark, so
 * `window_lag.guidance` is absent and there is no threshold to tune here.
 */
function formatWindowLag(lag: any): string {
  // The prose is `describeUnclaimedArrivals`'s string, the SAME one the JSON
  // payload carries as `guidance` — Automation runs read this response as JSON
  // through run_sdk and never render markdown, so the payload is the surface
  // that matters; this render is for clients that do read markdown.
  const guidance = typeof lag?.guidance === 'string' ? lag.guidance : '';
  if (!guidance) return '';
  return `## \u23F3 Unclaimed Arrivals\n\n${guidance}\n\n`;
}

/**
 * Format unprocessed ranges as markdown with read_knowledge call examples
 */
function formatUnprocessedRanges(ranges: any[], automationId?: string): string {
  const rangesToProcess = ranges.filter((r: any) => r.unprocessed_content > 0);
  if (rangesToProcess.length === 0) return '';

  const totalUnprocessed = rangesToProcess.reduce(
    (sum: number, r: any) => sum + r.unprocessed_content,
    0
  );
  const id = automationId || '<automation_id>';

  let md = `## 📋 Ranges To Process (${totalUnprocessed} unprocessed items)\n\n`;
  md += `Process these ${rangesToProcess.length} range(s) sequentially:\n\n`;

  for (let i = 0; i < rangesToProcess.length; i++) {
    const range = rangesToProcess[i];
    const isPartial = range.status === 'partial';
    md += `### ${i + 1}. ${range.month} (${range.unprocessed_content} items${isPartial ? `, ${range.processed_content} already processed` : ''})\n\n`;
    md += '```\n';
    md += 'read_knowledge(\n';
    md += `  automation_id: ${id},\n`;
    md += `  since: "${range.window_start.slice(0, 10)}",\n`;
    md += `  until: "${range.window_end.slice(0, 10)}",\n`;
    md += `  limit: ${Math.min(range.total_content, 2000)}\n`;
    md += ')\n';
    md += '```\n';
    if (isPartial) {
      md += '⚠️ **Partial**: Delete existing window first, then reprocess.\n';
    }
    md += '\n';
  }

  return md;
}

/**
 * Format extracted automation data (recursive)
 */
function formatExtractedData(data: any, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  let md = '';

  if (Array.isArray(data)) {
    data.forEach((item, idx) => {
      md += `${prefix}- **Item ${idx + 1}**:\n`;
      md += formatExtractedData(item, indent + 1);
    });
  } else if (typeof data === 'object' && data !== null) {
    Object.entries(data).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        md += `${prefix}**${key}**:\n`;
        md += formatExtractedData(value, indent + 1);
      } else {
        md += `${prefix}**${key}**: ${value}\n`;
      }
    });
  } else {
    md += `${prefix}${data}\n`;
  }

  return md;
}

/**
 * Format manage_automations result
 */
function formatManageAutomationsResult(result: any, _options: FormatterOptions): string {
  const { action, summary, automations, results } = result;

  let md = `# 📊 Automation Management: ${action}\n\n`;

  if (Array.isArray(result.templates)) {
    md += `## Templates (${result.templates.length})\n\n`;
    if (result.templates.length === 0) {
      md += '*No templates found.*\n';
      return md;
    }

    for (const template of result.templates) {
      md += `### ${template.name || template.slug}\n`;
      if (template.template_id) md += `- **ID**: \`${template.template_id}\`\n`;
      if (template.slug) md += `- **Slug**: ${template.slug}\n`;
      if (template.current_version) md += `- **Current Version**: ${template.current_version}\n`;
      if (template.version) md += `- **Version**: ${template.version}\n`;
      if (template.automations_count !== undefined) {
        md += `- **Automations**: ${template.automations_count}\n`;
      }
      if (template.installed !== undefined) {
        md += `- **Installed**: ${template.installed ? 'Yes' : 'No'}\n`;
      }
      if (template.description) md += `- **Description**: ${template.description}\n`;
      md += '\n';
    }

    return md;
  }

  if (action === 'create' && result.template_id && !result.automation_id) {
    md += '## New Template Created\n\n';
    md += `- **ID**: \`${result.template_id}\`\n`;
    md += `- **Slug**: ${result.slug}\n`;
    md += `- **Version**: ${result.version}\n`;
    return md;
  }

  if (action === 'install' && result.template_id) {
    md += '## Template Installed\n\n';
    md += `- **ID**: \`${result.template_id}\`\n`;
    md += `- **Slug**: ${result.slug}\n`;
    md += `- **Version**: ${result.version}\n`;
    md += `- **Updated**: ${result.updated ? 'Yes' : 'No'}\n`;
    if (result.message) md += `- **Message**: ${result.message}\n`;
    return md;
  }

  if (action === 'set_reaction_script') {
    md += '## Reaction Script\n\n';
    md += `- **Automation ID**: \`${result.automation_id}\`\n`;
    md += `- **Installed**: ${result.has_script ? 'Yes' : 'No'}\n`;
    if (result.message) md += `- **Message**: ${result.message}\n`;
    return md;
  }

  if (summary) {
    md += '## Summary\n\n';
    md += `- **Total**: ${summary.total}\n`;
    md += `- **Successful**: ✅ ${summary.successful}\n`;
    md += `- **Failed**: ❌ ${summary.failed}\n\n`;
  }

  // Show detailed results for operations that return them (delete, upgrade)
  if (results && results.length > 0 && action === 'delete') {
    const failedResults = results.filter((r: any) => !r.success);
    const successfulResults = results.filter((r: any) => r.success);

    if (failedResults.length > 0) {
      md += '## ❌ Failed Operations\n\n';
      for (const r of failedResults) {
        md += `- **Automation ID**: \`${r.automation_id}\`\n`;
        md += `  - **Error**: ${r.message}\n\n`;
      }
    }

    if (successfulResults.length > 0) {
      md += '## ✅ Successful Operations\n\n';
      for (const r of successfulResults) {
        md += `- **Automation ID**: \`${r.automation_id}\`\n`;
        md += `  - **Status**: ${r.message}\n\n`;
      }
    }
  }

  if (action === 'create' && result.automation_id) {
    md += '## New Automation Created\n\n';
    md += `- **ID**: \`${result.automation_id}\`\n`;
    md += `- **Template Version**: ${result.template_version}\n`;
    md += `- **Status**: ${result.status}\n`;
    if (result.view_url) {
      md += `- **View**: [${result.view_url}](${result.view_url})\n`;
    }
  }

  if (action === 'complete_window') {
    md += '## ✅ Window Completed\n\n';
    md += `- **Automation ID**: \`${result.automation_id}\`\n`;
    md += `- **Run ID**: \`${result.run_id}\`\n`;
    md += `- **Period**: ${result.window_start?.substring(0, 10)} - ${result.window_end?.substring(0, 10)}\n`;
    md += `- **Content Linked**: ${result.content_linked}\n`;
  }

  if (action === 'list' && automations && automations.length > 0) {
    md += `## Automations (${automations.length})\n\n`;
    for (const automation of automations) {
      md += `### ${automation.name || automation.template_slug}\n`;
      md += `- **ID**: \`${automation.automation_id}\`\n`;
      md += `- **Template**: ${automation.template_slug} (v${automation.template_version})\n`;
      md += `- **Status**: ${automation.status}\n`;
      md += `- **Entity**: ${automation.entity_name} (${automation.entity_type})\n`;
      if (automation.schedule) {
        md += `- **Schedule**: ${automation.schedule}\n`;
      }
      md += `- **Pending Content**: ${automation.pending_content_count ?? 'N/A'}\n`;
      md += '\n';
    }
  } else if (action === 'list') {
    md += '*No Automations found.*\n';
  }

  return md;
}

/**
 * Format query_sql result as CSV.
 *
 * `query_sql` has no `outputSchema`, so its markdown must distinguish a resolved
 * `{ rows: [], error }` failure from a successful empty result.
 */
function formatQuerySqlResult(result: any): string {
  const { rows, total_count, execution_time_ms } = result;

  if (typeof result?.error === 'string' && result.error.length > 0) {
    const code = result.error_code ? ` (${result.error_code})` : '';
    const retry =
      result.retryable === true
        ? '\n\nRetrying the identical call may succeed.'
        : result.retryable === false
          ? '\n\nRetrying the identical call will not help unless the query or arguments change.'
          : '';
    return `# ❌ Error${code}\n\n${result.error}${retry}\n\n*The query did not return data. This is a failure, not an empty result set.*`;
  }

  let csv = '';

  if (rows && rows.length > 0) {
    const columns = Object.keys(rows[0]);

    // CSV header
    csv += `${columns.map((col) => escapeCsvValue(col)).join(',')}\n`;

    // CSV rows
    rows.forEach((row: any) => {
      csv += `${columns.map((col) => escapeCsvValue(row[col])).join(',')}\n`;
    });
  }

  // Wrap in code block for easy copying
  return `# 💾 SQL Query Results (CSV)\n\n**Rows**: ${total_count} • **Time**: ${execution_time_ms}ms\n\n\`\`\`csv\n${csv}\`\`\`\n\n*Copy the CSV above and paste into Excel/Google Sheets*`;
}

/**
 * Escape a value for CSV format (RFC 4180)
 */
function escapeCsvValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }

  // Convert to string
  let str = typeof value === 'object' ? JSON.stringify(value) : String(value);

  // If the value contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Generic table formatter for arrays of objects
 * Automatically detects all fields and creates a markdown table
 */
function formatTable(
  items: any[],
  options: {
    excludeFields?: string[];
    fieldOrder?: string[];
    maxCellLength?: number;
    formatters?: Record<string, (value: any) => string>;
  } = {}
): string {
  if (!items || items.length === 0) {
    return 'No items to display.\n\n';
  }

  const { excludeFields = [], fieldOrder = [], maxCellLength = 50, formatters = {} } = options;

  // Get all unique field names from all items
  const allFields = new Set<string>();
  items.forEach((item) => {
    Object.keys(item).forEach((key) => {
      if (!excludeFields.includes(key)) {
        allFields.add(key);
      }
    });
  });

  // Order fields: specified order first, then alphabetically
  const orderedFields = [
    ...fieldOrder.filter((f) => allFields.has(f)),
    ...Array.from(allFields)
      .filter((f) => !fieldOrder.includes(f))
      .sort(),
  ];

  if (orderedFields.length === 0) {
    return 'No fields to display.\n\n';
  }

  // Create table header
  const headers = orderedFields.map((f) => formatFieldName(f));
  let md = `| ${headers.join(' | ')} |\n`;
  md += `| ${orderedFields.map(() => '---').join(' | ')} |\n`;

  // Create table rows
  items.forEach((item) => {
    const cells = orderedFields.map((field) => {
      const value = item[field];

      // Use custom formatter if provided
      if (formatters[field]) {
        return formatters[field](value);
      }

      // Default formatting
      return formatCellValue(value, maxCellLength);
    });
    md += `| ${cells.join(' | ')} |\n`;
  });

  md += '\n';
  return md;
}

/**
 * Format field name for table header (convert snake_case to Title Case)
 */
function formatFieldName(field: string): string {
  return field
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format a cell value for table display
 */
function formatCellValue(value: any, maxLength: number): string {
  if (value === null || value === undefined) {
    return '-';
  }

  if (typeof value === 'boolean') {
    return value ? '✅' : '❌';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    // Handle timestamps
    if (value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      return new Date(value).toLocaleString();
    }

    // Truncate long strings
    if (value.length > maxLength) {
      return `${value.substring(0, maxLength - 3)}...`;
    }

    return value;
  }

  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    if (json.length > maxLength) {
      return `${json.substring(0, maxLength - 3)}...`;
    }
    return `\`${json}\``;
  }

  return String(value);
}

// ============================================
// Get Content Formatter
// ============================================

/**
 * Format get_content result as markdown with thread hierarchy
 */
function formatGetContentResult(result: any, _options: FormatterOptions): string {
  const {
    content,
    total,
    page,
    classification_stats,
    window_token,
    window_start,
    window_end,
    window_lag,
    extraction_schema,
    sources,
    entities,
    unprocessed_ranges,
    reactions_guidance,
    past_reactions,
    past_feedback,
  } = result;

  let md = `# \uD83D\uDCDD Content (${total} total)\n\n`;

  // Automation mode: show window info and token
  if (window_token) {
    md += '## 🎯 Automation Window\n\n';
    md += `- **Window Start**: ${window_start}\n`;
    md += `- **Window End**: ${window_end}\n`;
    md += `- **Window Token**: \`${window_token}\`\n`;
    if (sources && Object.keys(sources).length > 0) {
      md += `- **Sources**: ${Object.keys(sources).join(', ')}\n`;
    }
    md += '\n';

    md += formatWindowLag(window_lag);

    if (extraction_schema) {
      md += `### Extraction Schema\n\n\`\`\`json\n${JSON.stringify(extraction_schema, null, 2)}\n\`\`\`\n\n`;
    }

    if (entities?.length > 0) {
      md += `### Bound Entities (${entities.length})\n\n`;
      md += formatTable(entities, {
        fieldOrder: ['id', 'name', 'type', 'metadata', 'field_controls'],
        maxCellLength: 300,
      });
    }

    if (sources && Object.keys(sources).length > 0) {
      md += '### Named Sources\n\n';
      for (const [name, rows] of Object.entries(sources)) {
        const sourceRows = Array.isArray(rows) ? rows : [];
        md += `#### ${name} (${sourceRows.length})\n\n`;
        md += formatTable(sourceRows, { maxCellLength: 300 });
      }
    }

    if (reactions_guidance) {
      md += `### Reactions Guidance\n\n${reactions_guidance}\n\n`;
    }

    if (past_reactions) {
      const body = past_reactions.replace(/^## Past Reactions\s*\n?/, '');
      md += `### Past Reactions\n\n${body}\n\n`;
    }

    if (past_feedback) {
      const body = past_feedback.replace(/^## Past Corrections from User Feedback\s*\n?/, '');
      md += `### Past Feedback\n\n${body}\n\n`;
    }
  }

  if (unprocessed_ranges?.length > 0) {
    md += formatUnprocessedRanges(unprocessed_ranges);
  }

  // Pagination info
  const currentPage = Math.floor((page?.offset || 0) / (page?.limit || 50)) + 1;
  md += `**Page**: ${currentPage} \u2022 **Showing**: ${content?.length || 0} of ${total} \u2022 **Has More**: ${page?.has_more ? 'Yes' : 'No'}\n\n`;

  // Classification stats summary (if included)
  if (classification_stats && Object.keys(classification_stats).length > 0) {
    md += '## Classification Summary\n\n';
    for (const [classifier, values] of Object.entries(
      classification_stats as Record<string, Record<string, number>>
    )) {
      const top3 = Object.entries(values)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([v, c]) => `${v} (${c})`)
        .join(', ');
      md += `- **${classifier}**: ${top3}\n`;
    }
    md += '\n';
  }

  // No content case
  if (!content || content.length === 0) {
    md += '*No events found.*\n';
    return md;
  }

  const formattableContent: FormattableContent[] = content.map((f: any) => ({
    ...f,
    depth: f.depth || 0,
  }));

  md += formatContentAsMarkdown(formattableContent, {
    includeClassifications: true,
    includeUrls: true,
    maxContentLength: 300,
  });

  return md;
}
