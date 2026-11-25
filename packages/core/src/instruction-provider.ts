import { createLogger } from "./logger";
import type { InstructionContext, InstructionProvider } from "./types";

const logger = createLogger("instruction-provider");

/**
 * Shared base for `InstructionProvider` implementations on both sides of the
 * gateway/worker boundary.
 *
 * Subclasses implement `buildInstructions(context)` with their domain logic.
 * The base wraps every call in a try/catch + structured logging, so unexpected
 * errors yield an empty string instead of crashing prompt assembly.
 *
 * Lives in `@lobu/core` (not server) so worker providers can extend it too —
 * before this lived in server-only and the worker reimplemented the same
 * try/catch loop in `generateCustomInstructions`.
 */
export abstract class BaseInstructionProvider implements InstructionProvider {
  abstract readonly name: string;
  abstract readonly priority: number;

  async getInstructions(context: InstructionContext): Promise<string> {
    try {
      return await this.buildInstructions(context);
    } catch (error) {
      logger.error(`Failed to build ${this.name} instructions`, { error });
      return "";
    }
  }

  protected abstract buildInstructions(
    context: InstructionContext
  ): Promise<string> | string;
}
