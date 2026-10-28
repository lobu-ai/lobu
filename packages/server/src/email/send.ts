import { render } from '@react-email/render';
import type { Env } from '@lobu/connector-sdk';
import type { ReactElement } from 'react';

type EmailCategory = 'auth' | 'invite';

interface TransactionalEmailInput {
  env: Env;
  to: string;
  subject: string;
  react: ReactElement;
  category: EmailCategory;
  /** Overrides the default From address for this category. */
  fromOverride?: string;
}

interface TransactionalEmailResult {
  id: string | null;
}

function resolveFrom(env: Env, category: EmailCategory, override?: string): string | null {
  if (override) return override;
  const configured = category === 'auth' ? env.EMAIL_FROM_AUTH : env.EMAIL_FROM_INVITES;
  if (configured) return configured;
  return null;
}

interface CloudflareSendResult {
  delivered: string[];
  message_id: string;
  permanent_bounces: string[];
  queued: string[];
  suppressed_recipients: string[];
}

interface CloudflareSendResponse {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: CloudflareSendResult | null;
}

/**
 * Send a transactional email via Cloudflare Email Sending with deliverability
 * best practices:
 *  - React Email component rendered to multipart html + plain-text body
 *  - List-Unsubscribe + List-Unsubscribe-Post (one-click) when EMAIL_UNSUBSCRIBE is set
 *  - Reply-To pointing at a monitored inbox
 *
 * Cloudflare has no equivalent of Resend's per-message tags, so the category
 * is recorded in server logs only. Delivery is fail-closed: any API-level
 * failure, or a definitive non-delivery of the recipient (hard bounce, or a
 * suppression drop when the sending domain is set to drop suppressed
 * recipients instead of rejecting the request), throws instead of returning
 * a false id.
 */
export async function sendTransactionalEmail(
  input: TransactionalEmailInput
): Promise<TransactionalEmailResult> {
  const { env, to, subject, react, category, fromOverride } = input;

  if (!env.CLOUDFLARE_EMAIL_API_TOKEN || !env.CLOUDFLARE_EMAIL_ACCOUNT_ID) {
    throw new Error(
      `Email delivery is not configured (CLOUDFLARE_EMAIL_API_TOKEN / CLOUDFLARE_EMAIL_ACCOUNT_ID missing) for ${category}.`
    );
  }

  const from = resolveFrom(env, category, fromOverride);
  if (!from) {
    const requiredVar = category === 'auth' ? 'EMAIL_FROM_AUTH' : 'EMAIL_FROM_INVITES';
    throw new Error(`${requiredVar} is required for ${category} email delivery.`);
  }

  const [html, text] = await Promise.all([render(react), render(react, { plainText: true })]);

  const headers: Record<string, string> = {};
  if (env.EMAIL_UNSUBSCRIBE) {
    const value = env.EMAIL_UNSUBSCRIBE.startsWith('<')
      ? env.EMAIL_UNSUBSCRIBE
      : `<${env.EMAIL_UNSUBSCRIBE}>`;
    headers['List-Unsubscribe'] = value;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  let response: globalThis.Response;
  try {
    response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_EMAIL_ACCOUNT_ID}/email/sending/send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          from,
          subject,
          html,
          text,
          ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
  } catch (err) {
    console.error(
      { to, from, category, err },
      '[Email] Cloudflare Email Sending request failed'
    );
    throw new Error(`${category} email delivery failed: request error.`);
  }

  let payload: CloudflareSendResponse;
  try {
    payload = (await response.json()) as CloudflareSendResponse;
  } catch {
    console.error(
      { to, from, category, status: response.status },
      '[Email] Cloudflare Email Sending returned non-JSON response'
    );
    throw new Error(`${category} email delivery failed (status ${response.status}).`);
  }

  if (!response.ok || !payload.success) {
    const first = payload.errors?.[0];
    console.error(
      { to, from, category, status: response.status, error: first },
      '[Email] Cloudflare Email Sending failed to deliver transactional email'
    );
    const detail = first ? ` (${first.code}: ${first.message})` : '';
    throw new Error(`${category} email delivery failed${detail}.`);
  }

  const result = payload.result;
  const id = result?.message_id ?? null;
  if (
    result &&
    (result.permanent_bounces.includes(to) || result.suppressed_recipients.includes(to))
  ) {
    console.error(
      { to, from, category, emailId: id, result },
      '[Email] Cloudflare Email Sending accepted but did not deliver to recipient'
    );
    throw new Error(`${category} email was not delivered to recipient.`);
  }
  if (result && (result.permanent_bounces.length > 0 || result.suppressed_recipients.length > 0)) {
    console.warn(
      { to, from, category, emailId: id, result },
      '[Email] Cloudflare Email Sending reported bounces or suppressions'
    );
  }

  console.info(
    { to, from, category, emailId: id },
    '[Email] Transactional email queued'
  );
  return { id };
}
