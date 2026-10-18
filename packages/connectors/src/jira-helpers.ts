/**
 * Shared Jira helpers, connector-owned.
 *
 * The bundled Jira connector (`jira.ts`) and the server's Atlassian Rovo MCP
 * feed adapter (`packages/server/src/operations/atlassian-mcp-feed.ts`) read
 * the same source (Jira Cloud issues via JQL) and must agree on the JQL
 * builder, the stable row shape, and ADF-to-text conversion. This module owns
 * that shared knowledge; transport (REST vs MCP tool call) stays with each
 * consumer. Server imports it as `@lobu/connectors/jira-helpers`.
 */

/** Stable column set returned by Jira direct source reads. */
export const JIRA_ISSUE_COLUMNS = [
  { name: 'id', type: 'string' },
  { name: 'key', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'reporter', type: 'string' },
  { name: 'priority', type: 'string' },
  { name: 'project_key', type: 'string' },
  { name: 'project_name', type: 'string' },
  { name: 'labels', type: 'string' },
  { name: 'created_at', type: 'string' },
  { name: 'updated_at', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'url', type: 'string' },
] as const;

/** Issue fields requested from `/rest/api/3/search/jql`. */
export const JIRA_ISSUE_FIELDS =
  'summary,description,status,assignee,reporter,priority,project,labels,created,updated';

/** Sort columns the live path can honor by rewriting ORDER BY. */
export const JIRA_SORT_COLUMNS: Record<string, string> = {
  updated: 'updated',
  updated_at: 'updated',
  created: 'created',
  created_at: 'created',
  key: 'key',
  priority: 'priority',
  status: 'status',
};

const ADF_BLOCK_TYPES = new Set([
  'blockquote',
  'bulletList',
  'codeBlock',
  'heading',
  'listItem',
  'orderedList',
  'paragraph',
  'rule',
  'table',
  'tableCell',
  'tableHeader',
  'tableRow',
]);

export function jiraAsString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function jiraActorName(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') {
    return typeof user === 'string' && user.trim() ? user.trim() : undefined;
  }
  const record = user as Record<string, unknown>;
  return (
    jiraAsString(record.displayName) ??
    jiraAsString(record.emailAddress) ??
    jiraAsString(record.name)
  );
}

export function jiraNamedField(value: unknown): string | undefined {
  if (typeof value === 'string') return jiraAsString(value);
  if (!value || typeof value !== 'object') return undefined;
  return jiraAsString((value as Record<string, unknown>).name);
}

/**
 * Jira v3 descriptions/comment bodies use the Atlassian Document Format (ADF) —
 * a nested JSON node tree. Flatten its text nodes to plain text. Strings (older
 * payloads) pass through unchanged.
 *
 * Block nodes join with `"\n"` so paragraphs do not glue together; inline
 * nodes (and `hardBreak`, which already contributes its own newline) join
 * cleanly.
 */
export function adfToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[] };
  // Soft line break inside a paragraph (not a block boundary).
  if (node.type === 'hardBreak') return '\n';
  if (typeof node.text === 'string') return node.text;
  if (Array.isArray(node.content)) {
    let out = '';
    for (const child of node.content) {
      const text = adfToText(child);
      if (!text) continue;
      const childType =
        child && typeof child === 'object'
          ? (child as { type?: string }).type
          : undefined;
      // hardBreak already contributes '\n' as its text; don't insert a second.
      if (out && childType && ADF_BLOCK_TYPES.has(childType)) out += '\n';
      out += text;
    }
    return out.trim();
  }
  return '';
}

/**
 * Peel a trailing `ORDER BY …` so caller JQL can be AND-composed without
 * wrapping the sort clause.
 */
export function splitTrailingOrderBy(jql: string): {
  body: string;
  orderBy: string | null;
} {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < jql.length; i += 1) {
    const char = jql[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      (i === 0 || /\s/.test(jql[i - 1])) &&
      /^order\s+by\b/i.test(jql.slice(i))
    ) {
      return { body: jql.slice(0, i).trim(), orderBy: jql.slice(i).trim() };
    }
  }
  return { body: jql.trim(), orderBy: null };
}

export function buildJiraJql(args: {
  baseQuery: string;
  query?: string;
  sort?: { column: string; order: 'asc' | 'desc' };
  defaultWhenEmpty?: string;
  window?: { start: string; end: string };
}): string {
  const trimmed = args.baseQuery.trim();
  // Keep an omitted scope bounded instead of scanning the whole site.
  const jql =
    trimmed.length > 0
      ? trimmed
      : (args.defaultWhenEmpty ?? 'updated >= -90d');

  // If the base is only ORDER BY, treat the restriction as empty and keep sort.
  let { body, orderBy } = splitTrailingOrderBy(jql);
  if (!body && orderBy) {
    body = args.window
      ? (args.defaultWhenEmpty ?? '')
      : (args.defaultWhenEmpty ?? 'updated >= -90d');
  }

  const callerQuery = args.query?.trim() ?? '';
  if (callerQuery) {
    const caller = splitTrailingOrderBy(callerQuery);
    if (caller.body) {
      body = body.length > 0 ? `(${body}) AND (${caller.body})` : caller.body;
    }
    if (caller.orderBy) {
      throw new Error(
        'Jira source read query cannot contain ORDER BY; use the separate sort field',
      );
    }
  }

  if (args.window) {
    const bounds = `updated >= ${Date.parse(args.window.start)} AND updated < ${Date.parse(args.window.end)}`;
    body = body ? `(${body}) AND (${bounds})` : bounds;
  }

  if (orderBy) {
    if (args.sort) {
      throw new Error(
        'Jira source read: cannot apply sort when the base JQL already contains ORDER BY',
      );
    }
    return body.length > 0 ? `${body} ${orderBy}` : orderBy;
  }

  if (args.sort) {
    const field = JIRA_SORT_COLUMNS[args.sort.column];
    if (!field) {
      throw new Error(
        `Jira source read sort column '${args.sort.column}' is unsupported; ` +
          `use one of: ${Object.keys(JIRA_SORT_COLUMNS).join(', ')}`,
      );
    }
    const dir = args.sort.order === 'asc' ? 'ASC' : 'DESC';
    return body.length > 0
      ? `${body} ORDER BY ${field} ${dir}`
      : `ORDER BY ${field} ${dir}`;
  }

  return body.length > 0
    ? `${body} ORDER BY updated DESC`
    : `${args.defaultWhenEmpty || 'updated >= -90d'} ORDER BY updated DESC`;
}

function jiraIssueUrl(
  issue: Record<string, unknown>,
  fields: Record<string, unknown>,
  config: Record<string, unknown>,
): string | undefined {
  const key = jiraAsString(issue.key);
  const siteUrl = jiraAsString(config.site_url);
  const cloudId = jiraAsString(config.cloud_id);
  const siteCloudId = jiraAsString(config.site_cloud_id);
  // Only rewrite to /browse when site_url was discovered for THIS cloud_id.
  // A feed-level cloud_id override must not inherit another site's host.
  if (siteUrl && key && cloudId && siteCloudId && cloudId === siteCloudId) {
    return `${siteUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
  }
  return (
    jiraAsString(issue.self) ??
    jiraAsString(fields.url) ??
    jiraAsString(issue.url)
  );
}

/**
 * Map one Jira issue (REST-shaped `{ id, key, fields }` or flattened MCP
 * payload) onto the stable issue row. Returns null when the payload carries
 * no usable issue identity.
 */
export function mapJiraIssueToRow(
  raw: unknown,
  config: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const issue = raw as Record<string, unknown>;
  const fields =
    issue.fields && typeof issue.fields === 'object'
      ? (issue.fields as Record<string, unknown>)
      : issue;
  const id =
    jiraAsString(issue.id) ??
    jiraAsString(issue.key) ??
    jiraAsString(fields.id);
  if (!id) return null;
  const labelsRaw = fields.labels ?? issue.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw
        .filter((label): label is string => typeof label === 'string')
        .join(', ') || null
    : (jiraAsString(labelsRaw) ?? null);
  const project =
    fields.project && typeof fields.project === 'object'
      ? (fields.project as Record<string, unknown>)
      : undefined;
  return {
    id,
    key: jiraAsString(issue.key) ?? jiraAsString(fields.key) ?? null,
    summary:
      jiraAsString(fields.summary) ?? jiraAsString(issue.summary) ?? null,
    status:
      jiraNamedField(fields.status) ?? jiraNamedField(issue.status) ?? null,
    assignee:
      jiraActorName(fields.assignee ?? issue.assignee) ?? null,
    reporter:
      jiraActorName(fields.reporter ?? issue.reporter) ?? null,
    priority:
      jiraNamedField(fields.priority) ?? jiraNamedField(issue.priority) ?? null,
    project_key:
      jiraAsString(project?.key) ??
      jiraAsString(fields.projectKey) ??
      jiraAsString(issue.project_key) ??
      null,
    project_name:
      jiraAsString(project?.name) ??
      jiraAsString(fields.projectName) ??
      null,
    labels,
    created_at:
      jiraAsString(fields.created) ?? jiraAsString(issue.created) ?? null,
    updated_at:
      jiraAsString(fields.updated) ?? jiraAsString(issue.updated) ?? null,
    description: adfToText(fields.description ?? issue.description) || null,
    url: jiraIssueUrl(issue, fields, config) ?? null,
  };
}
