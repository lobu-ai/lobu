/**
 * Destination-audience contract — how a connector tells the policy engine who
 * will see a write.
 *
 * An action marks the input that names where it writes with
 * `x-lobu-destination: true`. A connector that can read how wide that
 * destination's audience is registers a {@link DestinationAudienceSource};
 * a guardrail with an `audience` then applies only when the destination is at
 * least that wide (private < workspace < external). A connector without a
 * source never matches an audience guardrail.
 */

/**
 * - `private`: only invited members (a private channel, a DM, a group DM).
 * - `workspace`: anyone in the workspace can find and read it.
 * - `external`: people outside the workspace can read it (e.g. Slack Connect).
 * - `unknown`: the audience could not be read; policy treats it as `external`.
 */
export type DestinationAudience = 'private' | 'workspace' | 'external' | 'unknown';

/** The connection whose own credential reads the destination. */
export interface DestinationAudienceConnection {
  organizationId: string;
  connectionId: number;
}

export interface DestinationAudienceSource {
  connectorKey: string;
  /**
   * Classify the destination value the action's `x-lobu-destination` input
   * holds. Throwing, or not answering in time, counts as `unknown`.
   */
  destinationAudience(
    connection: DestinationAudienceConnection,
    destination: string
  ): Promise<DestinationAudience>;
}
