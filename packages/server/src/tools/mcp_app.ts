import {
  deepRedactSecrets,
  isSecretKey,
  REDACTED_SENTINEL,
} from '@lobu/core';
import { type Static, Type } from '@sinclair/typebox';
import { getScopedConnectorDefinition } from '../catalog/connector-definitions';
import { getDb } from '../db/client';
import type { Env } from '../index';
import {
  type ActionOrigin,
  actionOriginLabel,
  formatUtc,
} from '../notifications/action-card-state';
import { resolveInteractionActionOrigin } from '../notifications/action-origin';
import { ToolUserError } from '../utils/errors';
import {
  ApprovalKind,
  highApprovalImpact,
  normalApprovalImpact,
  readApprovalContext,
  type ApprovalImpact,
} from '../utils/approval-context';
import { buildResourcePermalink } from '../utils/url-builder';
import { CrossOrgAccessDenied, resolveCrossOrgToolContext } from '../sandbox/client-sdk';
import { requireWorkspaceContext } from './access-control';
import { manageOperations } from './admin/manage_operations';
import { getContent } from './get_content';
import { attachMcpResultMeta } from './mcp-result-meta';
import {
  type McpAppCapabilityBinding,
  canIssueMcpAppCapability,
  isMcpAppCapabilityBinding,
  issueMcpAppCapability,
  MCP_APP_CAPABILITY_MAX_LENGTH,
  mcpAppCapabilityMatchesHost,
  readMcpAppCapability,
} from './mcp-app-capability';
import type { AccountToolContext, ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';
import { getOrgUrlContext } from './view-urls';

const TITLE_MAX_LENGTH = 200;
const BLOCK_MAX_ITEMS = 100;
const TEXT_LABEL_MAX_LENGTH = 120;
const TEXT_VALUE_MAX_LENGTH = 20_000;
const CODE_VALUE_MAX_LENGTH = 40_000;
const DIFF_FIELD_MAX_ITEMS = 100;
const ACTION_MAX_ITEMS = 10;
const ACTION_ID_MAX_LENGTH = 80;
const ACTION_LABEL_MAX_LENGTH = 120;
const ACTION_HREF_MAX_LENGTH = 2_048;
const APPROVAL_CAPABILITY_TTL_MS = 10 * 60 * 1_000;
const APPROVAL_IMPACT_REASON_MAX_LENGTH = 500;
const APPROVAL_IMPACT_CONSEQUENCE_MAX_LENGTH = 500;
const APPROVAL_IMPACT_CONSEQUENCE_MAX_ITEMS = 5;
const CONNECTOR_KEY_MAX_LENGTH = 200;
const CONNECTOR_NAME_MAX_LENGTH = 200;
const CONNECTOR_FAVICON_DOMAIN_MAX_LENGTH = 253;
const DISPLAY_REDACTION = '[redacted]';
const SECRET_SCHEMA_VALUE_KEYS = new Set(['const', 'default', 'enum', 'example', 'examples']);

const TextBlockSchema = Type.Object({
  type: Type.Literal('text'),
  label: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
  value: Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH }),
  muted: Type.Optional(Type.Boolean()),
});

const CodeBlockSchema = Type.Object({
  type: Type.Literal('code'),
  value: Type.String({ maxLength: CODE_VALUE_MAX_LENGTH }),
});

const DiffBlockSchema = Type.Object({
  type: Type.Literal('diff'),
  fields: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: TEXT_LABEL_MAX_LENGTH }),
      before: Type.Optional(Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH })),
      after: Type.String({ maxLength: TEXT_VALUE_MAX_LENGTH }),
      format: Type.Optional(Type.Literal('code')),
    }),
    { maxItems: DIFF_FIELD_MAX_ITEMS }
  ),
});

const FormBlockSchema = Type.Object({
  type: Type.Literal('form'),
  schema: Type.Record(Type.String(), Type.Unknown()),
  initialValues: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const LobuViewBlockSchema = Type.Union([
  TextBlockSchema,
  CodeBlockSchema,
  DiffBlockSchema,
  FormBlockSchema,
]);

const ApprovalKindSchema = Type.Union(
  Object.values(ApprovalKind).map((kind) => Type.Literal(kind))
);

const ApprovalImpactSchema = Type.Object({
  level: Type.Union([Type.Literal('normal'), Type.Literal('high')]),
  reason: Type.Optional(Type.String({ maxLength: APPROVAL_IMPACT_REASON_MAX_LENGTH })),
  consequences: Type.Optional(
    Type.Array(Type.String({ maxLength: APPROVAL_IMPACT_CONSEQUENCE_MAX_LENGTH }), {
      maxItems: APPROVAL_IMPACT_CONSEQUENCE_MAX_ITEMS,
    })
  ),
});

const ConnectorIdentitySchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: CONNECTOR_KEY_MAX_LENGTH }),
  name: Type.String({ minLength: 1, maxLength: CONNECTOR_NAME_MAX_LENGTH }),
  favicon_domain: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: CONNECTOR_FAVICON_DOMAIN_MAX_LENGTH,
      pattern: '^[A-Za-z0-9.-]+$',
    })
  ),
});

const LinkActionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: ACTION_ID_MAX_LENGTH }),
  label: Type.String({ minLength: 1, maxLength: ACTION_LABEL_MAX_LENGTH }),
  variant: Type.Optional(
    Type.Union([
      Type.Literal('primary'),
      Type.Literal('outline'),
      Type.Literal('ghost'),
      Type.Literal('destructive'),
    ])
  ),
  icon: Type.Optional(Type.Literal('external')),
  terminal: Type.Optional(Type.Boolean()),
  href: Type.String({
    minLength: 1,
    maxLength: ACTION_HREF_MAX_LENGTH,
    pattern: '^https?://',
  }),
});

const ApprovalToolActionBaseFields = {
  label: Type.String({ minLength: 1, maxLength: ACTION_LABEL_MAX_LENGTH }),
  variant: Type.Optional(
    Type.Union([
      Type.Literal('primary'),
      Type.Literal('outline'),
      Type.Literal('ghost'),
      Type.Literal('destructive'),
    ])
  ),
  confirm: Type.Optional(Type.Boolean()),
  confirmPrompt: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
  terminal: Type.Optional(Type.Boolean()),
  resolvedLabel: Type.Optional(Type.String({ maxLength: TEXT_LABEL_MAX_LENGTH })),
} as const;

const ApprovalToolActionSchema = Type.Union([
  Type.Object({
    ...ApprovalToolActionBaseFields,
    id: Type.Literal('approve'),
    icon: Type.Optional(Type.Literal('check')),
    submitFormAs: Type.Optional(Type.Literal('input')),
    tool: Type.Literal('resolve_approval'),
    args: Type.Object({
      run_id: Type.Integer({ minimum: 1 }),
      decision: Type.Literal('approve'),
    }),
  }),
  Type.Object({
    ...ApprovalToolActionBaseFields,
    id: Type.Literal('reject'),
    icon: Type.Optional(Type.Literal('x')),
    tool: Type.Literal('resolve_approval'),
    args: Type.Object({
      run_id: Type.Integer({ minimum: 1 }),
      decision: Type.Literal('reject'),
    }),
  }),
]);

export const LobuViewSchema = Type.Object({
  version: Type.Literal(1),
  title: Type.Optional(Type.String({ maxLength: TITLE_MAX_LENGTH })),
  icon: Type.Optional(ApprovalKindSchema),
  connector: Type.Optional(ConnectorIdentitySchema),
  impact: Type.Optional(ApprovalImpactSchema),
  tone: Type.Optional(
    Type.Union([Type.Literal('warning'), Type.Literal('default'), Type.Literal('bare')])
  ),
  blocks: Type.Array(LobuViewBlockSchema, { maxItems: BLOCK_MAX_ITEMS }),
  actions: Type.Array(Type.Union([LinkActionSchema, ApprovalToolActionSchema]), {
    maxItems: ACTION_MAX_ITEMS,
  }),
});

export const ResolveApprovalSchema = Type.Object({
  run_id: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal('approve'), Type.Literal('reject')]),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.Optional(Type.String({ maxLength: 2_000 })),
});

export const GetApprovalSchema = Type.Object({
  run_id: Type.Integer({ minimum: 1 }),
  organization: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Target workspace slug or id. Available only to unscoped OAuth sessions.',
    })
  ),
});

type LobuView = Static<typeof LobuViewSchema>;
type LobuViewBlock = Static<typeof LobuViewBlockSchema>;

const DIFF_ROUTING_KEYS = new Set([
  'action',
  'agent_id',
  'base',
  'automation_id',
  'entity_id',
  'id',
  'owner_user_id',
  'reason',
]);

const DIFF_ENVELOPE_ROUTING_KEYS = new Set([
  'owner_agent_id',
  'owner_resolved',
  'policy_action',
  'policy_principal_id',
  'policy_principal_kind',
  'precondition',
  'resource_class',
  'schema_type',
  'version',
]);

const HIGH_IMPACT_APPROVAL_ACTIONS = new Set([
  'delete',
  'disconnect',
  'merge',
  'remove',
  'remove_rule',
  'reset',
  'revoke',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}…`;
}

function displayRedacted(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replaceAll(REDACTED_SENTINEL, DISPLAY_REDACTION);
  }
  if (Array.isArray(value)) return value.map(displayRedacted);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, displayRedacted(inner)])
  );
}

function isDisplaySecretKey(key: string): boolean {
  let candidate = key;
  while (true) {
    if (isSecretKey(candidate)) return true;
    if (!candidate.startsWith('input_')) return false;
    candidate = candidate.slice('input_'.length);
  }
}

/**
 * Approval metadata is stored for execution, not presentation. Redact by the
 * field name before detaching a primitive value from its key, then deep-walk
 * nested objects and URI userinfo using the shared Lobu secret classifier.
 */
function redactForDisplay(value: unknown, key?: string): unknown {
  if (key && value != null && isDisplaySecretKey(key)) return DISPLAY_REDACTION;
  return displayRedacted(deepRedactSecrets(value));
}

function stripSecretSchemaValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretSchemaValues);
  if (!isRecord(value)) return redactForDisplay(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_SCHEMA_VALUE_KEYS.has(key))
      .map(([key, inner]) => [key, stripSecretSchemaValues(inner)])
  );
}

function sanitizeFormFieldSchema(name: string, value: unknown): unknown {
  const sanitized = sanitizeFormSchema(value);
  if (!isDisplaySecretKey(name)) return sanitized;
  if (!isRecord(sanitized)) return DISPLAY_REDACTION;

  const field = stripSecretSchemaValues(sanitized) as Record<string, unknown>;
  if (field.type === 'string' || field.type === undefined) field.format = 'password';
  return field;
}

/** Preserve usable JSON Schema structure while removing secret-bearing values. */
function sanitizeFormSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFormSchema);
  if (!isRecord(value)) return redactForDisplay(value);

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (key === 'properties' && isRecord(inner)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(inner).map(([name, schema]) => [
              name,
              sanitizeFormFieldSchema(name, schema),
            ])
          ),
        ];
      }
      return [key, sanitizeFormSchema(inner)];
    })
  );
}

function sanitizeFormInitialValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeFormInitialValue);
  if (!isRecord(value)) return redactForDisplay(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isDisplaySecretKey(key))
      .map(([key, inner]) => [key, sanitizeFormInitialValue(inner)])
  );
}

function sanitizeFormInitialValues(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeFormInitialValue(value) as Record<string, unknown>;
}

function displayValue(value: unknown, maxLength: number, key?: string): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  const redacted = redactForDisplay(value, key);
  let rendered: string;
  if (typeof redacted === 'string') {
    rendered = redacted;
  } else {
    try {
      rendered = JSON.stringify(redacted, null, 2);
    } catch {
      rendered = String(redacted);
    }
  }
  return truncate(rendered, maxLength);
}

function displayFieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!words) return 'Field';
  return truncate(`${words.charAt(0).toUpperCase()}${words.slice(1)}`, TEXT_LABEL_MAX_LENGTH);
}

function displayFieldFormat(key: string, value: unknown): 'code' | undefined {
  if (
    Array.isArray(value) ||
    isRecord(value) ||
    key === 'slug' ||
    key.endsWith('_slug') ||
    key === 'rule_id' ||
    key === 'rules_source' ||
    (key === 'write_rules' && value !== 'None')
  ) {
    return 'code';
  }
  return undefined;
}

/**
 * Kind for an approval written before its producer stamped `approval_context`:
 * a row already pending at rollout still has to render as the kind of thing it
 * is. Keyed on `metadata.tool`, which every producer persists.
 */
function legacyApprovalKind(row: ApprovalContentItem): ApprovalKind {
  const metadata = row.metadata ?? {};
  if (metadata.tool === 'manage_entity_schema') return ApprovalKind.EntitySchema;
  if (metadata.tool === 'manage_agents') return ApprovalKind.Agent;
  if (metadata.tool === 'manage_automations') return ApprovalKind.Automation;
  if (metadata.tool === 'notify') return ApprovalKind.Question;
  if (
    metadata.tool === 'entity_change' ||
    metadata.tool === 'entity_field_change' ||
    metadata.resourceKind === 'entity'
  )
    return ApprovalKind.Entity;
  if (stringOrNull(row.platform) || metadata.operation_key) return ApprovalKind.Connector;
  return ApprovalKind.Approval;
}

function legacyApprovalImpact(
  metadata: Record<string, unknown> | null,
  kind: ApprovalKind
): ApprovalImpact {
  if (metadata?.review_tone === 'warning') {
    return highApprovalImpact('This action was marked as high impact by its producer.');
  }
  if (metadata?.review_tone === 'default') return normalApprovalImpact();
  const action = typeof metadata?.action === 'string' ? metadata.action.toLowerCase() : '';
  if (HIGH_IMPACT_APPROVAL_ACTIONS.has(action)) {
    return highApprovalImpact('This action can remove or irreversibly change data.');
  }
  if (kind === ApprovalKind.Connector) {
    return highApprovalImpact(
      'This connector approval predates impact metadata, so its external effect cannot be verified.',
      ['Review the connected-service change before approving.']
    );
  }
  return normalApprovalImpact();
}

function approvalImpactForView(impact: ApprovalImpact): ApprovalImpact {
  return {
    level: impact.level,
    ...(impact.reason !== undefined
      ? { reason: truncate(impact.reason, APPROVAL_IMPACT_REASON_MAX_LENGTH) }
      : {}),
    ...(impact.consequences !== undefined
      ? {
          consequences: impact.consequences
            .slice(0, APPROVAL_IMPACT_CONSEQUENCE_MAX_ITEMS)
            .map((item) => truncate(item, APPROVAL_IMPACT_CONSEQUENCE_MAX_LENGTH)),
        }
      : {}),
  };
}

function approvalContextForView(
  row: ApprovalContentItem,
  status: string
): { kind: ApprovalKind; impact: ApprovalImpact } {
  const explicit = readApprovalContext(row.metadata?.approval_context);
  const kind = explicit?.kind ?? legacyApprovalKind(row);
  if (status !== 'pending') {
    return {
      kind,
      impact: normalApprovalImpact(),
    };
  }
  return {
    kind,
    impact: approvalImpactForView(explicit?.impact ?? legacyApprovalImpact(row.metadata, kind)),
  };
}

function approvalBlocks(row: {
  content: string | null;
  interaction_input_schema: Record<string, unknown> | null;
  interaction_input: Record<string, unknown> | null;
  interaction_output: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): LobuViewBlock[] {
  const metadata = row.metadata ?? {};
  const proposal = isRecord(metadata.proposal) ? metadata.proposal : null;
  // Only platform producers with this durable shape store execution envelopes
  // in `proposal`. An ordinary proposal may legitimately contain user fields
  // named `args`, `schema_type`, or `version` and must keep them visible.
  const hasArgumentEnvelope =
    metadata.tool === 'manage_automations' || metadata.tool === 'manage_entity_schema';
  const proposalArgs =
    hasArgumentEnvelope && proposal && isRecord(proposal.args) ? proposal.args : null;
  const proposalCurrent =
    metadata.tool === 'manage_entity_schema' && proposal && isRecord(proposal.current)
      ? proposal.current
      : null;
  const current = isRecord(metadata.current) ? metadata.current : proposalCurrent;
  const fields = isRecord(metadata.fields) ? metadata.fields : null;
  const reviewFields = Array.isArray(metadata.review_fields)
    ? metadata.review_fields.flatMap((item) => {
        if (!isRecord(item) || typeof item.key !== 'string' || item.value === undefined) return [];
        return [[item.key, item.value] as [string, unknown]];
      })
    : null;
  // Durable proposals may be execution envelopes. Prefer producer-authored
  // review fields, then their public args; routing and policy state belongs in
  // the run/audit record, not in a human confirmation card.
  const proposed = fields ?? proposalArgs ?? proposal ?? row.interaction_input;
  const blocks: LobuViewBlock[] = [];

  if (reviewFields || proposed) {
    const diffFields = (reviewFields ?? Object.entries(proposed ?? {}))
      .filter(
        ([key, value]) =>
          !DIFF_ROUTING_KEYS.has(key) &&
          !(hasArgumentEnvelope && DIFF_ENVELOPE_ROUTING_KEYS.has(key)) &&
          value !== undefined
      )
      .slice(0, DIFF_FIELD_MAX_ITEMS)
      .map(([key, value]) => ({
        label: displayFieldLabel(key),
        ...(current && current[key] !== undefined
          ? { before: displayValue(current[key], TEXT_VALUE_MAX_LENGTH, key) }
          : {}),
        after: displayValue(value, TEXT_VALUE_MAX_LENGTH, key),
        ...(displayFieldFormat(key, value) ? { format: 'code' as const } : {}),
      }));
    if (diffFields.length > 0) blocks.push({ type: 'diff', fields: diffFields });
  }

  if (row.interaction_input_schema) {
    const submittedAnswer = isRecord(row.interaction_output?.answer)
      ? row.interaction_output.answer
      : null;
    const formValues = submittedAnswer ?? row.interaction_input;
    blocks.push({
      type: 'form',
      schema: sanitizeFormSchema(row.interaction_input_schema) as Record<string, unknown>,
      ...(formValues
        ? {
            initialValues: sanitizeFormInitialValues(formValues),
          }
        : {}),
    });
  } else if (
    blocks.length === 0 &&
    row.interaction_input &&
    Object.keys(row.interaction_input).length > 0
  ) {
    blocks.push({
      type: 'code',
      value: displayValue(row.interaction_input, CODE_VALUE_MAX_LENGTH),
    });
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      value: displayValue(row.content || 'Review this pending Lobu action.', TEXT_VALUE_MAX_LENGTH),
      muted: true,
    });
  }
  return blocks;
}

type ApprovalContentItem = {
  id: number;
  run_id: number;
  created_at: string;
  client_id: string | null;
  platform: string | null;
  agent_id: string | null;
  automation_id: number | null;
  title: string | null;
  payload_text: string;
  interaction_type: 'approval';
  interaction_status: string | null;
  interaction_input_schema: Record<string, unknown> | null;
  interaction_input: Record<string, unknown> | null;
  interaction_output: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function safeFaviconDomain(value: unknown): string | null {
  const domain = stringOrNull(value);
  if (
    !domain ||
    domain.length > CONNECTOR_FAVICON_DOMAIN_MAX_LENGTH ||
    !/^[A-Za-z0-9.-]+$/.test(domain)
  ) {
    return null;
  }
  return domain;
}

async function approvalConnectorIdentity(
  row: ApprovalContentItem,
  kind: ApprovalKind,
  ctx: ToolContext
): Promise<NonNullable<LobuView['connector']> | null> {
  if (kind !== ApprovalKind.Connector) return null;
  const connectorKey = stringOrNull(row.platform) ?? stringOrNull(row.metadata?.connector_key);
  if (!connectorKey) return null;
  const definition = await getScopedConnectorDefinition({
    organizationId: ctx.organizationId,
    connectorKey,
  });
  const faviconDomain = safeFaviconDomain(definition?.favicon_domain);
  return {
    key: truncate(connectorKey, CONNECTOR_KEY_MAX_LENGTH),
    name: truncate(definition?.name ?? connectorKey, CONNECTOR_NAME_MAX_LENGTH),
    ...(faviconDomain ? { favicon_domain: faviconDomain } : {}),
  };
}

function approvalDecisionBlock(
  row: ApprovalContentItem,
  status: string
): LobuViewBlock | null {
  if (status === 'pending') return null;
  const reviewer =
    typeof row.metadata?.reviewed_by_name === 'string'
      ? row.metadata.reviewed_by_name.trim()
      : '';
  // A decision appends a NEW event version (supersedeActionEvent), so this
  // row's created_at is the decision time for cards written before
  // `reviewed_at` was stamped.
  const timestamp =
    formatUtc(
      typeof row.metadata?.reviewed_at === 'string' ? row.metadata.reviewed_at : row.created_at
    ) ?? '';
  const decisionStatus =
    row.metadata?.reviewed_at && (status === 'completed' || status === 'failed')
      ? 'approved'
      : status;
  const decision = `${decisionStatus.charAt(0).toUpperCase()}${decisionStatus.slice(1)}`;
  return {
    type: 'text',
    label: 'Decision',
    value: `${decision}${reviewer ? ` by ${reviewer}` : ''}${timestamp ? ` · ${timestamp}` : ''}`,
    muted: true,
  };
}

async function approvalOrigin(row: ApprovalContentItem, ctx: ToolContext): Promise<ActionOrigin> {
  const runs = await getDb()<{
    automation_id: number | null;
    initiator_ref: Record<string, unknown> | null;
    original_client_id: string | null;
    created_by_user_id: string | null;
  }>`
    SELECT r.automation_id, r.initiator_ref, r.created_by_user_id, original.client_id AS original_client_id
    FROM runs r
    LEFT JOIN LATERAL (
      SELECT e.client_id
      FROM events e
      WHERE e.run_id = r.id
        AND e.organization_id = r.organization_id
        AND e.interaction_type = 'approval'
      ORDER BY e.id ASC
      LIMIT 1
    ) original ON true
    WHERE r.id = ${row.run_id} AND r.organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  const metadata = row.metadata ?? {};
  const initiator = isRecord(metadata.initiator)
    ? metadata.initiator
    : (runs[0]?.initiator_ref ?? {});
  const automationId =
    Number(runs[0]?.automation_id ?? row.automation_id ?? initiator.automation_id ?? 0) || null;
  // The MCP activity row is keyed by the host conversation id when the host
  // exposes one and by the transport session id when it does not — the same
  // choice `currentMcpActivityAttribution` made when the row was written.
  const mcpActivityId =
    stringOrNull(metadata.mcp_conversation_id) ?? stringOrNull(metadata.mcp_session_id);
  const conversationId = mcpActivityId ?? stringOrNull(initiator.conversation_id);
  if (!automationId && !conversationId) return { kind: 'direct', label: 'Direct request' };
  return resolveInteractionActionOrigin({
    organizationId: ctx.organizationId,
    userId: runs[0]?.created_by_user_id ?? null,
    automationId,
    conversationId,
    // get_content's `platform` column carries the event's connector_key, never a
    // chat platform, so it is deliberately not a fallback here.
    platform: mcpActivityId ? 'mcp' : stringOrNull(initiator.platform),
    clientIdentity:
      ctx.memberRole != null
        ? (stringOrNull(initiator.client_id) ?? row.client_id ?? runs[0]?.original_client_id ?? null)
        : null,
    agentId: row.agent_id ?? stringOrNull(initiator.agent_id),
  });
}

function approvalOriginBlock(origin: ActionOrigin): LobuViewBlock {
  return {
    type: 'text',
    label: actionOriginLabel(origin.kind),
    value: displayValue(origin.label, TEXT_VALUE_MAX_LENGTH),
    muted: true,
  };
}

function isApprovalContentItem(value: unknown, runId: number): value is ApprovalContentItem {
  if (!isRecord(value)) return false;
  return value.run_id === runId && value.interaction_type === 'approval';
}

function belongsToApprovalBatch(row: ApprovalContentItem): boolean {
  const sourceRunId = row.metadata?.source_run_id;
  return sourceRunId !== undefined && sourceRunId !== null;
}

type ApprovalCapability = McpAppCapabilityBinding & {
  v: 2;
  runId: number;
  eventId: number;
};

function isApprovalCapability(value: unknown): value is ApprovalCapability {
  if (!isMcpAppCapabilityBinding(value)) return false;
  const payload = value as McpAppCapabilityBinding & Record<string, unknown>;
  return (
    payload.v === 2 &&
    Number.isInteger(payload.runId) &&
    Number.isInteger(payload.eventId)
  );
}

function canIssueApprovalCapability(
  row: ApprovalContentItem,
  status: string,
  ctx: ToolContext
): ctx is ToolContext & {
  userId: string;
  clientId: string;
  mcpSessionId: string;
} {
  // Deliberately NOT gated on `ctx.mcpAppsSupported`. That flag answers "did
  // the client announce the Apps extension", which is a different question
  // from "can this client render a card and call back through it" — claude.ai
  // renders while announcing nothing, so gating here left its card showing
  // Approve/Reject it could never obtain the right to press.
  //
  // This widens who receives the capability without widening what it reaches:
  // the token stays bound to org/user/client/session with a TTL, and
  // `resolve_approval` stays absent from `tools/list` for a non-declaring
  // client, so the model cannot invoke it — only the rendered card can, via
  // `tools/call`. The conditions kept below are the ones carrying real weight.
  return (
    status === 'pending' &&
    canIssueMcpAppCapability(ctx) &&
    !belongsToApprovalBatch(row)
  );
}

function issueApprovalCapability(
  row: ApprovalContentItem,
  ctx: ToolContext & { userId: string; clientId: string; mcpSessionId: string }
): string {
  return issueMcpAppCapability(
    { v: 2, runId: row.run_id, eventId: row.id },
    ctx,
    APPROVAL_CAPABILITY_TTL_MS
  );
}

function readApprovalCapability(token: string | null | undefined): ApprovalCapability {
  if (!token || token.length > MCP_APP_CAPABILITY_MAX_LENGTH) {
    throw new ToolUserError('A valid MCP App approval capability is required.', 403);
  }
  const parsed = readMcpAppCapability(token);
  if (!isApprovalCapability(parsed)) {
    throw new ToolUserError('The MCP App approval capability is invalid or expired.', 403);
  }
  return parsed;
}

async function findApprovalRow(
  runId: number,
  env: Env,
  ctx: ToolContext
): Promise<ApprovalContentItem> {
  // Reuse the canonical knowledge read so connection visibility, public-org
  // rules, caller identity, and MCP scope checks cannot drift from the event
  // surface. A direct current_event_records query here would be tenant-fenced
  // but could bypass a private connection's ACL.
  const result = await getContent(
    { run_ids: [runId], limit: 50, sort_by: 'date', sort_order: 'desc' },
    env,
    ctx
  );
  const listedRow = result.content.find((item) => isApprovalContentItem(item, runId));
  if (!listedRow) throw new ToolUserError(`Approval run ${runId} was not found`, 404);

  // Agent-facing list reads intentionally bound nested event JSON. The
  // host-authored card still needs the full canonical approval context so it
  // can redact secrets first and then apply its own view limits. Re-read the
  // already-authorized event through the exact-id path rather than bypassing
  // get_content visibility with a direct table query.
  let offset = 0;
  while (true) {
    const exact = await getContent(
      { content_ids: [listedRow.id], limit: 50, offset },
      env,
      ctx
    );
    const row = exact.content.find(
      (item): item is ApprovalContentItem =>
        isApprovalContentItem(item, runId) && item.id === listedRow.id
    );
    if (row) return row;
    if (!exact.page.has_more || exact.content.length === 0) break;
    offset += exact.content.length;
  }
  throw new ToolUserError(`Approval run ${runId} was not found`, 404);
}

async function buildApprovalView(runId: number, env: Env, ctx: ToolContext): Promise<LobuView> {
  const row = await findApprovalRow(runId, env, ctx);
  const status = row.interaction_status ?? 'pending';
  const approvalContext = approvalContextForView(row, status);
  const [origin, connector] = await Promise.all([
    approvalOrigin(row, ctx).catch(() => ({
      kind: 'direct' as const,
      label: 'Direct request',
    })),
    approvalConnectorIdentity(row, approvalContext.kind, ctx).catch(() => null),
  ]);
  const decisionBlock = approvalDecisionBlock(row, status);
  const baseTitle = displayValue(row.title ?? `Approval run ${runId}`, TITLE_MAX_LENGTH).replace(
    /\s+—\s+(?:pending approval|approved|rejected|completed|failed|cancelled)$/i,
    ''
  );
  const actions: LobuView['actions'] = [];
  if (status === 'pending') {
    const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
    const href = buildResourcePermalink(ownerSlug, { kind: 'run', runId }, baseUrl);
    if (!href || href.length > ACTION_HREF_MAX_LENGTH || !/^https?:\/\//i.test(href)) {
      throw new ToolUserError('The Lobu review link is unavailable for this workspace.', 500);
    }
    const appCanResolve = canIssueApprovalCapability(row, status, ctx);
    if (appCanResolve) {
      actions.push(
        {
          id: 'approve',
          label: 'Approve',
          variant: 'primary',
          icon: 'check',
          resolvedLabel: 'Approved.',
          ...(row.interaction_input_schema ? { submitFormAs: 'input' as const } : {}),
          tool: 'resolve_approval',
          args: { run_id: runId, decision: 'approve' },
        },
        {
          id: 'reject',
          label: 'Reject',
          variant: 'outline',
          icon: 'x',
          confirm: true,
          confirmPrompt: 'Reject this pending action?',
          resolvedLabel: 'Rejected.',
          tool: 'resolve_approval',
          args: { run_id: runId, decision: 'reject' },
        }
      );
    }
    actions.push({
      id: 'review',
      label: 'Review in Lobu',
      variant: appCanResolve ? 'outline' : 'primary',
      icon: 'external',
      terminal: false,
      href,
    });
  }

  const view: LobuView = {
    version: 1,
    title: truncate(
      status === 'pending' ? baseTitle : `${baseTitle} · ${status}`,
      TITLE_MAX_LENGTH
    ),
    icon: approvalContext.kind,
    ...(connector ? { connector } : {}),
    impact: approvalContext.impact,
    tone: approvalContext.impact.level === 'high' ? 'warning' : 'default',
    blocks: [
      ...approvalBlocks({
        content: row.payload_text,
        interaction_input_schema: row.interaction_input_schema,
        interaction_input: row.interaction_input,
        interaction_output: row.interaction_output,
        metadata: row.metadata,
      }),
      approvalOriginBlock(origin),
      ...(decisionBlock ? [decisionBlock] : []),
    ],
    actions,
  };
  return attachMcpResultMeta(view, {
    // A cross-org card is rendered for the target workspace. Keep the app's
    // role display aligned with the same target context that authored actions.
    'lobu/member-role': ctx.memberRole,
    ...(canIssueApprovalCapability(row, status, ctx)
      ? { 'lobu/approval-capability': issueApprovalCapability(row, ctx) }
      : {}),
  });
}

/**
 * Resolve a target workspace for an MCP-App tool call. `resolveCrossOrgToolContext`
 * reports denial with the SDK's typed error, which only the sandbox translates;
 * at a plain tool boundary it would surface as a generic failure. Re-raise it as
 * a ToolUserError so REST and MCP agree on the status — 403 for denial, matching
 * the sibling stale-capability check. Unknown and ungranted workspaces are
 * deliberately indistinguishable.
 */
async function resolveApprovalWorkspace(
  slugOrId: string,
  ctx: AccountToolContext
): Promise<ToolContext> {
  try {
    return await resolveCrossOrgToolContext(slugOrId, ctx);
  } catch (error) {
    if (error instanceof CrossOrgAccessDenied) {
      throw new ToolUserError(error.message, 403);
    }
    throw error;
  }
}

const getApprovalImpl = async (
  args: Static<typeof GetApprovalSchema>,
  env: Env,
  ctx: AccountToolContext
): Promise<LobuView> => {
  const approvalCtx = args.organization
    ? await resolveApprovalWorkspace(args.organization, ctx)
    : requireWorkspaceContext(ctx);
  return buildApprovalView(args.run_id, env, approvalCtx);
};

export const getApproval = withValidatedArgs(
  'get_approval',
  GetApprovalSchema,
  getApprovalImpl
);

type ResolveApprovalArgs = Static<typeof ResolveApprovalSchema>;

const resolveApprovalImpl = async (
  args: ResolveApprovalArgs,
  env: Env,
  ctx: AccountToolContext
): Promise<LobuView> => {
  const capability = readApprovalCapability(ctx.mcpAppApprovalCapability);
  // Drops `ctx.mcpAppsSupported` for the same reason issuance does — and it
  // has to drop it in the SAME change, or a card holding a freshly-issued
  // capability gets a 403 on every press. What remains authenticates the round
  // trip: the capability must name this run and still be bound to the calling
  // host — `mcpAppCapabilityMatchesHost` re-checks user, client and expiry.
  if (
    capability.runId !== args.run_id ||
    !mcpAppCapabilityMatchesHost(capability, ctx)
  ) {
    throw new ToolUserError('The MCP App approval capability is stale or does not match.', 403);
  }

  // The encrypted card capability carries the authoritative workspace. An
  // unscoped OAuth session may resolve it under the same login; scoped/PAT
  // connections remain unable to cross their bound workspace.
  const approvalCtx =
    capability.organizationId === ctx.organizationId
      ? requireWorkspaceContext(ctx)
      : await resolveApprovalWorkspace(capability.organizationId, ctx);

  const current = await findApprovalRow(args.run_id, env, approvalCtx);
  if (current.interaction_status !== 'pending' || current.id !== capability.eventId) {
    throw new ToolUserError('This approval capability is stale; the run is no longer pending.', 409);
  }
  if (belongsToApprovalBatch(current)) {
    throw new ToolUserError('Batched proposals must be reviewed in Lobu.', 409);
  }

  // The encrypted capability proves a signed-in OAuth user deliberately used
  // this app surface. The canonical approval handler still performs its own
  // membership and run-owner/admin authority checks; clear only the non-human
  // transport identities after the capability has been fully revalidated.
  const humanContext: ToolContext = {
    ...approvalCtx,
    agentId: null,
    clientId: null,
    mcpSessionId: null,
    mcpAppApprovalCapability: null,
  };
  const result = await manageOperations(
    args.decision === 'approve'
      ? { action: 'approve', run_id: args.run_id, ...(args.input ? { input: args.input } : {}) }
      : { action: 'reject', run_id: args.run_id, ...(args.reason ? { reason: args.reason } : {}) },
    env,
    humanContext
  );
  if ('error' in result && typeof result.error === 'string') {
    throw new ToolUserError(result.error, 409);
  }
  return buildApprovalView(args.run_id, env, approvalCtx);
};

export const resolveApproval = withValidatedArgs(
  'resolve_approval',
  ResolveApprovalSchema,
  resolveApprovalImpl
);
