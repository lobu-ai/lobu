/**
 * Shared identity and participant framing for chat platforms.
 *
 * An agent reached over chat needs two facts nothing else in the prompt
 * supplies: WHO it is in the conversation, and that the messages it receives
 * are addressed TO it. Without them it has only its identity/soul markdown,
 * which describes the principal in the third person ("you work on the user's
 * data on their behalf") and never says the person currently typing IS that
 * principal. The model resolves that ambiguity per turn, often the wrong way:
 * it treats the message as observed conversation about a third party and
 * narrates it back — "Burak is asking … how would you like to respond?" — to an
 * operator who does not exist. Slack never showed this only because its
 * provider happened to say "You are reachable in Slack as `@x`", which implies
 * participation; every platform declaring no provider got nothing.
 *
 * Identity is best-effort, the framing is not. `Adapter.botUserId` is optional
 * in the Chat SDK, a turn may carry no `connectionId`, and the store can fail —
 * in all three cases the handle is omitted but the framing still renders, since
 * the framing is the half that resolves the ambiguity.
 *
 * PROMPT-CACHE CONTRACT — read before adding a line here.
 * This block follows the agent layers in the turn system prompt
 * (`composeTurnSystemPrompt` in `agent-turn-producer.ts`), and the
 * openai-completions path has no explicit cache breakpoints: reuse is
 * longest-common-prefix only. Everything emitted here must be CONNECTION-scoped
 * (platform, bot handle, bot id) — constant for the life of the connection, so
 * every conversation on it shares one prefix. Never interpolate anything
 * CONVERSATION-scoped (sender name, channel/chat id, message text, timestamps):
 * that hands every new conversation a unique prefix and forfeits the cache for
 * all of them. Those belong in the per-turn run context, which is not cached.
 * A test pins this by rendering two users/sessions on one connection and
 * asserting byte equality.
 */
import {
  BaseInstructionProvider,
  createLogger,
  type InstructionContext,
} from "@lobu/core";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { ChatInstanceManager } from "./chat-instance-manager.js";
import { chatPlatformLabel } from "./platform-label.js";

const logger = createLogger("chat-identity-instructions");

export interface ChatBotIdentity {
  botUsername?: string;
  botUserId?: string;
}

export class ChatIdentityInstructionProvider extends BaseInstructionProvider {
  // Widened to `string` deliberately: an inferred literal type would make the
  // property invariant and block a subclass from naming itself.
  readonly name: string = "chat-identity";
  readonly priority = 20;

  constructor(
    protected readonly manager: ChatInstanceManager,
    protected readonly platform: string
  ) {
    super();
  }

  protected async resolveIdentity(
    context: InstructionContext
  ): Promise<ChatBotIdentity | null> {
    const { organizationId, connectionId } = context;
    if (!organizationId || !connectionId) return null;
    const connection = await orgContext.run(
      { organizationId },
      () => this.manager.getConnection(connectionId)
    );
    if (!connection) return null;

    const botUsername = connection.metadata?.botUsername;
    const botUserId = connection.metadata?.botUserId;
    return {
      ...(typeof botUsername === "string" && botUsername
        ? { botUsername }
        : {}),
      ...(typeof botUserId === "string" && botUserId ? { botUserId } : {}),
    };
  }

  protected async buildInstructions(
    context: InstructionContext
  ): Promise<string> {
    let identity: ChatBotIdentity | null = null;
    try {
      identity = await this.resolveIdentity(context);
    } catch (error) {
      logger.warn(
        { error, connectionId: context.connectionId },
        "Failed to resolve chat identity; using generic framing"
      );
    }
    return this.renderIdentity(identity ?? {});
  }

  protected renderIdentity(identity: ChatBotIdentity): string {
    const label = chatPlatformLabel(this.platform);
    const lines: string[] = [`**${label} identity:**`];

    if (identity.botUsername && identity.botUserId) {
      lines.push(
        `- You are reachable in ${label} as \`@${identity.botUsername}\` (user ID \`${identity.botUserId}\`).`
      );
    } else if (identity.botUsername) {
      lines.push(
        `- You are reachable in ${label} as \`@${identity.botUsername}\`.`
      );
    } else if (identity.botUserId) {
      lines.push(`- Your ${label} user ID is \`${identity.botUserId}\`.`);
    } else {
      lines.push(`- You are reachable in this ${label} conversation.`);
    }

    lines.push(
      "- You are a participant in this conversation, not an outside observer.",
      '- Reply directly to the people in this conversation. Address them as "you" rather than describing them in the third person, and do not ask an unseen operator how to respond.'
    );

    return lines.join("\n");
  }
}
