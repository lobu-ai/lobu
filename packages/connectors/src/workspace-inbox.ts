import {
  ConnectorRuntime,
  validatePublicUrl,
  type ActionContext,
  type ActionResult,
  type RuntimeConnectorDefinition,
} from '@lobu/connector-sdk';

/** A send-only connection to an existing authenticated Lobu webhook inbox.
 * The connection fixes the recipient; operation input never carries authority.
 */
export default class WorkspaceInboxConnector extends ConnectorRuntime {
  readonly definition: RuntimeConnectorDefinition = {
    key: 'workspace-inbox',
    name: 'Workspace inbox',
    description:
      'Send a reviewed message or feedback report to a configured workspace inbox. Does not grant access to recipient workspace data. An administrator must configure the destination and authentication first.',
    version: '1.0.0',
    authSchema: {
      methods: [{
        type: 'env_keys',
        required: true,
        scope: 'connection',
        fields: [{ key: 'AUTHORIZATION', label: 'Inbox authorization', secret: true, required: true }],
      }],
    },
    optionsSchema: {
      type: 'object',
      properties: {
        inbox_url: {
          type: 'string',
          format: 'uri',
          description: 'Administrator-configured HTTPS webhook URL. Never put credentials in the URL.',
        },
      },
      required: ['inbox_url'],
      additionalProperties: false,
    },
    feeds: {},
    actions: {
      send_message: {
        key: 'send_message',
        name: 'Send message to workspace inbox',
        description:
          'Share the exact reviewed subject, body and references with the configured recipient. Useful for user-approved bug reports and product feedback. Exclude secrets and unrelated private content. A receipt confirms storage, not triage, reproduction, or resolution. Configure Ask when each message needs human review.',
        kind: 'write',
        annotations: { destructiveHint: false, openWorldHint: true, idempotentHint: true },
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', minLength: 1, maxLength: 160 },
            body: { type: 'string', minLength: 1, maxLength: 12000 },
            references: {
              type: 'array',
              maxItems: 5,
              default: [],
              items: { type: 'string', format: 'uri', pattern: '^https?://' },
              description: 'References only; sending does not fetch them or grant the recipient access.',
            },
          },
          required: ['subject', 'body'],
          additionalProperties: false,
        },
      },
    },
  };

  async execute(ctx: ActionContext): Promise<ActionResult> {
    if (ctx.actionKey !== 'send_message') return { success: false, error: 'Unknown workspace inbox action' };
    const rawUrl = ctx.config.inbox_url;
    if (typeof rawUrl !== 'string') return { success: false, error: 'Inbox destination is not configured' };
    try {
      validatePublicUrl(rawUrl);
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        return { success: false, error: 'Inbox destination must be HTTPS without credentials, query, or fragment' };
      }
      // Only the existing Lobu webhook contract supplies the durable receipt below.
      if (!/\/api\/v1\/webhooks\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
        return { success: false, error: 'Inbox destination must be a Lobu webhook URL' };
      }
    } catch {
      return { success: false, error: 'Inbox destination must be a public HTTPS webhook URL' };
    }
    // Stable bytes preserve the receiver's body-hash dedupe across uncertain
    // deliveries. Never add a freshly generated timestamp or identity claim.
    const body = JSON.stringify({
      subject: ctx.input.subject,
      body: ctx.input.body,
      references: ctx.input.references ?? [],
    });
    let response: Response;
    try {
      response = await fetch(rawUrl, {
        method: 'POST',
        redirect: 'error',
        // The auth profile's immutable HTTP binding adds authorization at
        // the gateway. Neither the token nor its value enters this isolate.
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch {
      return { success: false, error: 'Inbox delivery could not be confirmed; inspect the existing run before retrying with the same input and idempotency key' };
    }
    if (response.status !== 202) {
      await response.body?.cancel();
      return { success: false, error: `Inbox rejected delivery (HTTP ${response.status})` };
    }
    // The receiver returns a tiny receipt; never surface arbitrary response data.
    const reader = response.body?.getReader();
    if (!reader) return { success: false, error: 'Inbox returned no delivery receipt' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return { success: false, error: 'Inbox returned an invalid delivery receipt' };
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const receipt = JSON.parse(new TextDecoder().decode(bytes));
      if (receipt?.ok !== true || !Number.isSafeInteger(receipt.id) || receipt.id <= 0) {
        return { success: false, error: 'Inbox returned an invalid delivery receipt' };
      }
      return { success: true, output: { status: 'received', receipt: String(receipt.id) } };
    } catch {
      return { success: false, error: 'Inbox delivery receipt could not be confirmed' };
    } finally {
      reader.releaseLock();
    }
  }
}
