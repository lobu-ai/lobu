/**
 * get_component_reference action handler for manage_automations.
 * Returns static documentation about available Automation components and data types.
 */

import type { ComponentReferenceDocumentation } from '../../../types/templates';

// ============================================
// handleGetComponentReference
// ============================================

export function handleGetComponentReference(): {
  action: 'get_component_reference';
  documentation: ComponentReferenceDocumentation;
} {
  return {
    action: 'get_component_reference',
    documentation: {
      overview:
        'Automations define extraction prompts, schemas, SQL source queries, and optional JSON rendering. Native Lobu event JSON templates can use permission-checked Automation, Connector and Agent references plus collapsible JSON details. These are native app template nodes, not React exports from @lobu/views/components; sandboxed React views do not inherit this registry.',
      data_types: [
        {
          type: 'source',
          description:
            'SQL data source query. If it references the events table, time window bounds are auto-applied via CTE scoping.',
          required_fields: ['name', 'query'],
          example: {
            name: 'daily_volume',
            query:
              "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
          },
        },
      ],
      available_components: [
        {
          name: 'card',
          category: 'Layout',
          description: 'Container with border and padding.',
          example: { type: 'card', children: [{ type: 'text', content: 'Content' }] },
        },
        {
          name: 'each',
          category: 'Control flow',
          description: 'Iterates over arrays in data payload.',
          example: {
            type: 'each',
            items: 'items',
            as: 'item',
            render: { type: 'data', path: 'item.name' },
          },
        },
        {
          name: 'automation-ref',
          category: 'Native Lobu references',
          description:
            'Render the native Automation identity row or inline reference from a currently authorized record. Live mode resolves canonical identity and navigation; authored labels/statuses/links cannot impersonate live state. For a static proposal, compose ordinary card, badge and text nodes instead of a live reference.',
          props: {
            mode: 'Required: live. No implicit default.',
            workspace: 'Live only: workspace slug, 1–128 characters.',
            automationId: 'Live only: positive safe integer represented as a string, 1–128 characters.',
            appearance: 'Live only: inline | row; defaults to row.',
          },
          example: {
            type: 'automation-ref',
            props: { mode: 'live', workspace: '{{item.workspace}}', automationId: '{{item.automationId}}', appearance: 'row' },
          },
        },
        {
          name: 'connector-ref',
          category: 'Native Lobu references',
          description:
            'Reuse the native connector display. A connector catalog entry is not proof of a connected account; supply connectionId only for a specific authorized connection.',
          props: {
            mode: 'Required: live.',
            workspace: 'Live only: workspace slug, 1–128 characters.',
            connectorKey: 'Live only: connector key, 1–128 characters.',
            connectionId: 'Live only: optional positive safe integer connection ID.',
            appearance: 'Live only: inline | row; defaults to row.',
          },
          example: {
            type: 'connector-ref',
            props: { mode: 'live', workspace: '{{source.workspace}}', connectorKey: '{{source.connectorKey}}', connectionId: '{{source.connectionId}}' },
          },
        },
        {
          name: 'agent-ref',
          category: 'Native Lobu references',
          description:
            'Reuse the native Agent row from current authorized identity. An agent reference is not a device reference or permission to delegate work.',
          props: {
            mode: 'Required: live.',
            workspace: 'Live only: workspace slug, 1–128 characters.',
            agentId: 'Live only: agent identifier, 1–128 characters.',
            appearance: 'Live only: inline | row; defaults to row.',
          },
          example: {
            type: 'agent-ref',
            props: { mode: 'live', workspace: '{{item.workspace}}', agentId: '{{item.agentId}}' },
          },
        },
        {
          name: 'json-diff',
          category: 'Native Lobu details',
          description:
            'Reuse the native collapsible JSON change viewer. Both object sides render a before/after diff; one object side renders a static snapshot. Missing or non-object sides are treated as absent. This is a display, not an approval or mutation.',
          props: { before: 'Object or null.', after: 'Object or null.' },
          example: { type: 'json-diff', props: { before: '{{change.before}}', after: '{{change.after}}' } },
        },
        {
          name: 'tabs',
          category: 'Native report navigation',
          description: 'Native local report navigation. Only the active panel mounts. This is presentation state, not an automation action, route or permission grant.',
          props: { defaultValue: 'Required non-empty string, at most 128 characters; must match a tabs-trigger and tabs-content value.' },
          example: { type: 'tabs', props: { defaultValue: 'digest' }, children: [{ type: 'tabs-list', props: { label: 'Social views' }, children: [{ type: 'tabs-trigger', props: { value: 'digest' }, children: [{ type: 'text', content: 'Digest' }] }] }, { type: 'tabs-content', props: { value: 'digest' }, children: [{ type: 'text', content: 'Saved report content' }] }] },
        },
        {
          name: 'tabs-list',
          category: 'Native report navigation',
          description: 'Accessible list of tabs-trigger children within tabs. Arrow keys, Home and End activate the focused tab.',
          props: { label: 'Optional accessible label, at most 200 characters; default Views.' },
          example: { type: 'tabs-list', props: { label: 'Report views' }, children: [{ type: 'tabs-trigger', props: { value: 'digest' }, children: [{ type: 'text', content: 'Digest' }] }] },
        },
        {
          name: 'tabs-trigger',
          category: 'Native report navigation',
          description: 'Native button-styled tab label; use text children. Its value identifies the matching tabs-content panel.',
          props: { value: 'Required non-empty string, at most 128 characters.' },
          example: { type: 'tabs-trigger', props: { value: 'digest' }, children: [{ type: 'text', content: 'Digest' }] },
        },
        {
          name: 'tabs-content',
          category: 'Native report navigation',
          description: 'Report panel rendered only when its value is selected in the enclosing tabs.',
          props: { value: 'Required non-empty string, at most 128 characters.' },
          example: { type: 'tabs-content', props: { value: 'digest' }, children: [{ type: 'text', content: 'Saved report content' }] },
        },
      ],
      security_restrictions: [
        'Tabs accept only the documented local values/labels. No callbacks, href, class, style or controlled value are forwarded. Separate tab families can be nested for independent report sections.',
        'Prompts are literal instruction text; no template expansion or code execution happens inside them.',
        'SQL queries are restricted to read-only SELECT/WITH statements.',
        'Native reference selectors never grant access. Server permissions govern reads and navigation; invalid, missing or refused records render an unavailable state rather than trusting authored identity. Live means a resolved saved resource, not a continuous status stream. References revalidate on mount, focus, reconnect and existing app invalidations; there is no interval polling. Changes and access revocation are reflected on the next completed read, not promised instantaneously. Visitor preview is conservatively unavailable; normal anonymous access still follows server permissions.',
        'Exact {{path}} prop bindings preserve value types; mixed text interpolates to a string. Resolve bindings before reference validation. Use strings for automationId and numbers for connectionId.',
        'Reference nodes do not expose enable, run, send, publish or approval callbacks. Existing declared event interactions remain a separate authorization path; do not invent actions or bypass an approval through a reference.',
        'Snapshot mode accepts only label, description and capturedAt. It is explicitly static and has no ID, URL, current status or executable action. Do not make a proposal look like a live record.',
        'Native event JSON rendering is separate from the sandboxed React view runtime. Do not import AutomationReference, ConnectorReference, AgentReference or JsonDiff from @lobu/views/components on the strength of this reference.',
      ],
      complete_examples: [
        {
          name: 'Native event with an Automation reference',
          description:
            'Select the authorized workspace with client.org(workspace). Read the owning entity type with workspace.entitySchema.getType(slug); merge its existing event_kinds before workspace.entitySchema.updateType({ slug, event_kinds: mergedKinds }). The dedicated kind entry supplies jsonTemplate as a root node, for example { type: "automation-ref", props: { mode: "live", workspace: "{{automation.workspace}}", automationId: "{{automation.id}}" } }. Schema changes require the existing owner/admin policy. Then save workspace.knowledge.save({ semantic_type: "review_note", payload_type: "empty", payload_data: { automation: { workspace: "example-workspace", id: "42" } }, title: "Automation review", idempotency_key: "example-review-1" }). These selectors are synthetic examples: discover actual authorized IDs before use. The empty payload activates the registered kind renderer; text/markdown content bypasses it. Public knowledge.save does not accept an authored payload_template or payload_type json_template. Keep readable fallback data in the event and verify the actual event page after the native registry is deployed. Updating an existing event_kinds object replaces the registry, so never omit unrelated kinds. Do not attach an unrelated custom React view to the new kind.',
        },
        {
          name: 'Problem Detection',
          description: 'Extracts recurring product issues from source content.',
          prompt:
            "Analyze the bound entities' feedback in the window content and extract recurring problems.",
          outputs: {
            problems: { entity: 'problem', key: ['name'] },
          },
          data: {
            daily_volume: {
              query:
                "SELECT DATE_TRUNC('day', occurred_at) as day, COUNT(*) as count FROM events GROUP BY 1 ORDER BY 1",
            },
          },
        },
      ],
    },
  };
}
