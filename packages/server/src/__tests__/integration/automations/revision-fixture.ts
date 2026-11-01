import { buildAutomationsNamespace } from '../../../sandbox/namespaces/automations';
import type { ToolContext } from '../../../tools/registry';

type AutomationReader = {
  automations: { get(input: { automation_id: string }): Promise<unknown> };
};

/** An explicit fixture read, before the edit being tested; mutations never fetch their own token. */
export async function readAutomationRevision(client: AutomationReader, id: string | number): Promise<string> {
  const result = await client.automations.get({ automation_id: String(id) }) as {
    automation?: { revision?: unknown };
  };
  if (typeof result.automation?.revision !== 'string') {
    throw new Error(`Automation fixture ${id} did not return its revision`);
  }
  return result.automation.revision;
}

export async function readAutomationRevisions(client: AutomationReader, ids: readonly (string | number)[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(ids.map(async id => [String(id), await readAutomationRevision(client, id)])));
}

export function readAutomationRevisionForContext(ctx: ToolContext, id: string | number): Promise<string> {
  return readAutomationRevision({ automations: buildAutomationsNamespace(ctx, { ENVIRONMENT: 'test' }) }, id);
}
