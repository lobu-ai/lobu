/** Exercises the real admission gate and shared limiter, with injected sender tiers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandlerBridge } from '../../gateway/connections/message-handler-bridge';
import {
  type ChatTurnActor,
  UNLINKED_ORGANIZATION_TURNS_PER_HOUR,
  UNLINKED_SENDER_TURNS_PER_HOUR,
} from '../../gateway/orchestration/chat-turn-actor';
import { resetRateLimiterForTests } from '../../utils/rate-limiter';
import { cleanupTestDatabase } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

type Admit = (args: {
  organizationId: string | undefined;
  userId: string;
  teamId: string | undefined;
  isDirect: boolean;
  senderVouched: boolean;
  thread: { post: () => Promise<void> };
}) => Promise<{ accessNoticePosted: boolean } | null>;

function bridgeWithTier(
  organizationId: string,
  tierOf: (senderId: string) => ChatTurnActor | undefined,
  platform: 'slack' | 'gchat' = 'slack',
  post = async () => {},
) {
  const services = {
    getArtifactStore: () => ({}),
    getPublicGatewayUrl: () => 'https://gateway.test/lobu',
  };
  const bridge = new MessageHandlerBridge(
    { id: `synthetic-${platform}-conn`, platform, organizationId } as never,
    services as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    async ({ senderId }) => tierOf(senderId),
  );
  const admit = (bridge as unknown as { admitChatSender: Admit }).admitChatSender.bind(bridge);
  return (senderId: string) =>
    admit({
      organizationId,
      userId: senderId,
      teamId: 'T0SYNTHCAP',
      isDirect: false,
      senderVouched: false,
      thread: { post },
    }).then((admission) => admission !== null);
}

describe('workspace-wide cap on unlinked chat turns', () => {
  let organizationId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    resetRateLimiterForTests();
    // Freeze only Date so a slow run cannot refill an epoch-aligned hourly window.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1, 12) });
    organizationId = (await createTestOrganization({ name: `Unlinked Cap Org ${Date.now()}` })).id;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRateLimiterForTests();
  });

  async function admittedFrom(admit: (senderId: string) => Promise<boolean>, senders: string[]) {
    let admitted = 0;
    for (const sender of senders) {
      for (let turn = 0; turn < UNLINKED_SENDER_TURNS_PER_HOUR; turn += 1) {
        if (await admit(sender)) admitted += 1;
      }
    }
    return admitted;
  }

  function strangers(prefix: string) {
    const count = Math.ceil(UNLINKED_ORGANIZATION_TURNS_PER_HOUR / UNLINKED_SENDER_TURNS_PER_HOUR) + 1;
    return Array.from({ length: count }, (_, index) => `U0${prefix}${index}`);
  }

  it('shares the ceiling across concurrent reply-only and public-visitor turns on different platforms', async () => {
    const replyOnly = bridgeWithTier(organizationId, () => ({ access: 'reply_only' }));
    const publicVisitor = bridgeWithTier(organizationId, () => ({ access: 'public_visitor' }), 'gchat');
    const admissions = await Promise.all(
      Array.from({ length: UNLINKED_ORGANIZATION_TURNS_PER_HOUR + 1 }, (_, index) =>
        (index % 2 === 0 ? replyOnly : publicVisitor)(`U0CONCURRENT${index}`),
      ),
    );
    expect(admissions.filter(Boolean)).toHaveLength(UNLINKED_ORGANIZATION_TURNS_PER_HOUR);
  });

  it('blocks on a fresh limiter without posting a notice, then refills in the next hour', async () => {
    const tier = () => ({ access: 'reply_only' as const });
    expect(await admittedFrom(bridgeWithTier(organizationId, tier), strangers('SHARED')))
      .toBe(UNLINKED_ORGANIZATION_TURNS_PER_HOUR);
    // No pod-local counts survive: the next admission must consult Postgres.
    resetRateLimiterForTests();
    const post = vi.fn(async () => {});
    const admit = bridgeWithTier(organizationId, tier, 'slack', post);
    expect(await admit('U0FRESHPOD')).toBe(false);
    expect(post).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect(await admit('U0FRESHPOD')).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('still admits a vouched sender and a linked member once the ceiling is reached', async () => {
    const admit = bridgeWithTier(organizationId, (sender) =>
      sender === 'U0VOUCHED'
        ? { access: 'org_shared' }
        : sender === 'U0MEMBER'
          ? { access: 'member', actorUserId: 'user_synthetic_member' }
          : sender === 'U0LINKEDGROUP'
            ? { access: 'org_shared', actorUserId: 'user_synthetic_member' }
            : { access: 'reply_only' },
    );
    expect(await admit('U0VOUCHED')).toBe(true);
    expect(await admit('U0MEMBER')).toBe(true);
    expect(await admit('U0LINKEDGROUP')).toBe(true);
    expect(await admittedFrom(admit, strangers('FLOOD'))).toBe(UNLINKED_ORGANIZATION_TURNS_PER_HOUR);
    expect(await admit('U0FRESHSTRANGER')).toBe(false);
    expect(await admit('U0VOUCHED')).toBe(true);
    expect(await admit('U0MEMBER')).toBe(true);
    expect(await admit('U0LINKEDGROUP')).toBe(true);
  });

  it('keeps each organization on its own ceiling', async () => {
    const tier = () => ({ access: 'reply_only' as const });
    await admittedFrom(bridgeWithTier(organizationId, tier), strangers('ORGA'));
    const other = (await createTestOrganization({ name: `Unlinked Cap Other ${Date.now()}` })).id;
    expect(await bridgeWithTier(other, tier)('U0ORGBSENDER')).toBe(true);
  });
});
