/** The directory uses its own OAuth resource; existing clients retain /mcp. */
export const DIRECTORY_MCP_PATH = '/mcp-directory';

export function isAccountMcpPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, '');
  return normalized === '/mcp' || normalized === DIRECTORY_MCP_PATH;
}

export function isDirectoryMcpRequest(url: string): boolean {
  return new URL(url).pathname.replace(/\/+$/, '') === DIRECTORY_MCP_PATH;
}

/** These same names constrain listing AND dispatch, including app calls. */
export const DIRECTORY_MCP_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  search_memory: 'Search saved knowledge in authorized Lobu workspaces, with source references and coverage. Use workspace to narrow the search. For a known memory id, search for "memory <id>" with include_content. Live connected sources are not read by this tool.',
  save_memory: 'Save an explicitly requested fact, decision, preference or note to the selected authorized workspace. Search first to avoid duplicates. Storage is append-only; supersedes_event_id replaces an older fact while preserving its history. Use org_slug to select the workspace and idempotency_key for retries.',
  open_view: 'Open the authorized workspace and view picker, or open a known view by key. SQL and static views are supported here; views requiring other tools show an unavailable message. Record, collection and event views require their scope. Keyed results include a web URL.',
  query_sql: 'Read saved Lobu workspace data using bounded, read-only SQL. Tables are scoped to the selected authorized workspace. Use org_slug to select the workspace and title to describe the result. External database connections are unavailable on this endpoint.',
};

export const DIRECTORY_MCP_INSTRUCTIONS = [
  '## Lobu — Shared workspace memory',
  'Use these tools for a user-requested workspace task: search saved knowledge, save an explicit note, or open a workspace view.',
  'Use open_view without arguments to browse authorized workspaces. Select an explicit workspace before saving or querying saved data.',
  'Search memory before saving. Save only when the user asks or confirms. Preserve source references and report search coverage honestly.',
  'This connection supports saved-workspace SQL and static views. Other view reads and actions are unavailable; explain the limitation and offer the returned Lobu web URL.',
  'Configure integrations, devices and Automations in Lobu. This connection does not discover or execute external operations, configure Automations, or read live connected sources.',
  'Never request or expose authentication secrets.',
].join('\n');
