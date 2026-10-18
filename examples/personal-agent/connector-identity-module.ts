/**
 * Connector-owned identity module contract. Mirrors
 * `@lobu/connectors/connector-identity-module` — redeclared here because the
 * example package depends only on `@lobu/connector-sdk`, which does not
 * re-export that type.
 */
export interface ConnectorIdentityModule {
  /** Connector/platform key. */
  key: string;
  /**
   * Namespaces this connector owns that participate in read-time event recall.
   * Each MUST have a physical `idx_events_metadata_<ns>` partial index.
   */
  recallNamespaces: string[];
  /**
   * Normalize a value for one of this connector's namespaces. Returns
   * `undefined` when the namespace is not owned here (the caller chains to the
   * next module, then to generic SDK hygiene). `null` means the namespace IS
   * owned but the value is invalid.
   */
  normalize(namespace: string, raw: string): string | null | undefined;
}
