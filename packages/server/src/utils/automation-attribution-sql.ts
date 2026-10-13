/**
 * Shared SQL for automation attribution on event rows.
 *
 * Prefer the producing version's name to preserve historical attribution,
 * then the automation's current name, then an id label. Aliases are static
 * SQL identifiers supplied by callers, never user input.
 */
export function automationNameColumn(eventsAlias: string): string {
  return `COALESCE(wv.name, wauto.name, 'Automation #' || ${eventsAlias}.automation_id)`;
}

export function automationNameJoin(eventsAlias: string): string {
  return `LEFT JOIN automations wauto ON wauto.id = ${eventsAlias}.automation_id AND wauto.organization_id = ${eventsAlias}.organization_id`;
}
