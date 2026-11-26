/**
 * Keyed circuit breaker. When a key has seen `failureThreshold`
 * consecutive transport failures, the breaker trips for `cooldownMs` and all
 * further requests fail without calling the model.
 *
 * Closed (healthy): requests hit the model; failures increment the counter.
 * Open (tripped): requests short-circuit until cooldown expires.
 * Half-open (probe): after cooldown, one request is allowed through; if it
 *   succeeds the breaker closes, if it fails the breaker re-opens.
 */
/**
 * Cap on tracked keys, so the state map cannot grow forever. When the cap is
 * hit the oldest inserted entry is evicted; a key that has been healthy long
 * enough to fall out of the window loses nothing.
 */
const MAX_TRACKED_KEYS = 1000;

export class CircuitBreaker {
  private readonly state = new Map<
    string,
    {
      consecutiveFailures: number;
      openUntil: number;
      halfOpenInFlight: boolean;
    }
  >();

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number
  ) {}

  /**
   * Called before issuing a model request. Returns `true` if the caller
   * should proceed to call the model, or `false` if the breaker is open
   * and the caller should fail closed.
   */
  canProceed(key: string): boolean {
    const entry = this.state.get(key);
    if (!entry) return true;
    if (entry.openUntil === 0) return true; // closed
    if (Date.now() >= entry.openUntil) {
      // Half-open: allow at most one probe in flight.
      if (entry.halfOpenInFlight) return false;
      entry.halfOpenInFlight = true;
      return true;
    }
    return false;
  }

  onSuccess(key: string): void {
    this.state.delete(key);
  }

  onFailure(key: string): void {
    const entry =
      this.state.get(key) ??
      ({
        consecutiveFailures: 0,
        openUntil: 0,
        halfOpenInFlight: false,
      } as const);
    const next = {
      consecutiveFailures: entry.consecutiveFailures + 1,
      openUntil: entry.openUntil,
      halfOpenInFlight: false,
    };
    if (next.consecutiveFailures >= this.failureThreshold) {
      next.openUntil = Date.now() + this.cooldownMs;
    }
    if (
      !this.state.has(key) &&
      this.state.size >= MAX_TRACKED_KEYS
    ) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
    this.state.set(key, next);
  }

  /** For tests. */
  isOpen(key: string): boolean {
    const entry = this.state.get(key);
    if (!entry) return false;
    return entry.openUntil > 0 && Date.now() < entry.openUntil;
  }

  /** For tests. */
  reset(): void {
    this.state.clear();
  }
}
