import type {
  AutomationEventTrigger,
  AutomationTrigger,
} from '@lobu/core/contracts/tools/manage-automations';
import type { ConnectorTriggerSignal } from '@lobu/connector-sdk';

export function referenceCaptureTriggers(triggers: AutomationTrigger[]): AutomationEventTrigger[] {
  return triggers.filter((trigger): trigger is AutomationEventTrigger => trigger.kind === 'event'
    && trigger.source !== 'workspace' && trigger.capture === 'references');
}

/**
 * Connector-neutral signal after webhook/chat authentication and normalization.
 * Provider drivers own those boundaries; the Automation only sees this small
 * value plus a reference to the already-durable source record.
 */
function matchesTrigger(
  trigger: AutomationEventTrigger,
  signal: ConnectorTriggerSignal,
): boolean {
  if (trigger.connector_key !== signal.connector_key) return false;
  if (signal.unchanged && trigger.skip_if_unchanged !== false) return false;
  if (
    trigger.connection_id !== undefined &&
    trigger.connection_id !== signal.connection_id
  ) {
    return false;
  }
  if (!trigger.event_types.includes(signal.event_type)) return false;

  const normalizedFields: Record<
    string,
    string | number | boolean | null | undefined
  > = {
    ...signal.attributes,
    resource_type: signal.resource_type,
    resource_ref: signal.resource_ref,
  };
  return Object.entries(trigger.match ?? {}).every(([key, expected]) => {
    // team_id is system-written delivery metadata (chat-link creation, Grid
    // self-heal, migration backfill), never a user-facing catalog filter. The
    // legacy binding lookup routed by channel alone; enforcing team equality
    // here silently drops Slack Connect messages (author's workspace id) and
    // payloads that omit team. channel/connection identity still gates.
    if (key === 'team_id') return true;
    // mention_only:false is an unchecked UI checkbox ("no filter"), not
    // "only non-mentions". Treat it as absent so already-stored rows still
    // match every message; writes strip the key in normalizeAutomationTriggers.
    if (key === 'mention_only' && expected === false) return true;
    return normalizedFields[key] === expected;
  });
}

/** Select event activations independently from an Automation's context sources. */
export function matchingAutomationTriggers(
  triggers: AutomationEventTrigger[],
  signal: ConnectorTriggerSignal,
): AutomationEventTrigger[] {
  return triggers.filter((trigger) => matchesTrigger(trigger, signal));
}
