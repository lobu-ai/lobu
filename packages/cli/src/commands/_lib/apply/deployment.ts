/**
 * Deployment identity for `lobu apply`.
 *
 * Each apply run mints an `apply_id`, sends it as `x-lobu-apply-id` on every
 * mutation (the server stamps its config-audit events with it), and posts a
 * summary to `POST /api/<org>/deployments` at the end — including the
 * redacted desired-state snapshot (`manifest`) that makes the deployment
 * self-contained: `lobu rollback <apply_id>` re-applies it through the same
 * diff/execute engine, repointing connectors to their retained versions. The
 * summary still records the config repo's HEAD SHA so git-first rollback
 * (revert commit → re-apply) stays first-class for config-as-code orgs.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { deepRedactSecrets, REDACTED_SENTINEL } from "@lobu/core";
import type { DesiredState } from "./desired-state.js";
import type { Baseline, DiffPlan, DiffRow, RemoteSnapshot } from "./diff.js";
import {
  canonical,
  effectiveEntityTypeAfterApply,
  effectiveRelationshipTypeAfterApply,
  projectDesiredAutomation,
} from "./diff.js";
import { automationExecutionConfig } from "./shared.js";

export function mintApplyId(): string {
  return `apl_${randomUUID()}`;
}

export interface GitInfo {
  sha: string | null;
  dirty: boolean | null;
}

/** HEAD SHA + dirty flag of the config repo; nulls outside a git work tree. */
export function collectGitInfo(cwd: string): GitInfo {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return { sha: sha || null, dirty: porcelain.length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

/**
 * Structurally redact the fields that hold RESOLVED secret values in process
 * memory — agent `providerKeys[].value`, org provider `apiKey`, and auth-profile
 * `credentials` (resolved from `$VAR`/`secret()` at map time) — then deep-redact
 * by key-name denylist. Shared by the manifest hash and the stored deployment
 * snapshot: a snapshot NEVER carries a secret value, so `lobu rollback`
 * structurally cannot re-apply one.
 */
export function redactDesiredState(
  state: DesiredState
): Record<string, unknown> {
  return deepRedactSecrets({
    ...state,
    agents: state.agents.map((agent) => ({
      ...agent,
      providerKeys: agent.providerKeys.map((k) => ({
        providerId: k.providerId,
        value: REDACTED_SENTINEL,
      })),
    })),
    providers: (state.providers ?? []).map((p) => ({
      ...p,
      apiKey: REDACTED_SENTINEL,
    })),
    connectors: {
      ...state.connectors,
      authProfiles: state.connectors.authProfiles.map((profile) => ({
        ...(profile as unknown as Record<string, unknown>),
        credentials: REDACTED_SENTINEL,
      })),
    },
  }) as Record<string, unknown>;
}

/**
 * sha256 of the redacted, canonicalized desired state. The hash identifies a
 * config revision; two applies of the same config (same secrets or not) hash
 * identically because secret VALUES never participate.
 */
export function computeManifestHash(state: DesiredState): string {
  return `sha256:${createHash("sha256")
    .update(canonical(redactDesiredState(state)))
    .digest("hex")}`;
}

export const SNAPSHOT_VERSION = 1;

export interface DeploymentManifest {
  version: typeof SNAPSHOT_VERSION;
  /**
   * The redacted desired state, minus connector source bytes: connector
   * definitions are stripped to declaration metadata, and the artifacts they
   * resolved to ride `connector_versions` below as retained
   * (org, key, version) pins — a deployment is self-contained without ever
   * embedding code or secrets.
   */
  state: Record<string, unknown>;
  /** Active connector version per declared key, recorded post-install. */
  connector_versions: Record<string, string>;
  /**
   * The attribution baseline for the three-way drift compare: the effective
   * entity/rel-type and Automation state AFTER this apply (declared config
   * values + preserved unmanaged facets). When absent, declared definitions
   * use the ordinary two-way diff while provenance-dependent deletes fail
   * closed.
   */
  attribution?: {
    entityTypes: unknown[];
    relationshipTypes: unknown[];
    automations: unknown[];
  };
  /**
   * Kind-qualified definition incarnation identities (`entity-type:12`,
   * `automation:b7-…`) this config actually applied — the delete-eligible set.
   */
  owned?: string[];
}

export interface BaselineRecord {
  attribution: {
    entityTypes: unknown[];
    relationshipTypes: unknown[];
    automations: unknown[];
  };
  owned: string[];
  /** Connector key → version from the deployment's post-apply pins. */
  connectorVersions?: Record<string, string>;
}

/**
 * Parse the stored baseline; null when attribution was never recorded. A
 * partially-shaped attribution (a manifest written before the Automation
 * cutover carries no `automations` array) is treated the same way: it cannot
 * prove ownership, so it must fail closed rather than read as "empty".
 */
export function loadBaselineFromManifest(
  manifest: {
    attribution?: DeploymentManifest["attribution"];
    owned?: DeploymentManifest["owned"];
    connector_versions?: Record<string, string>;
  } | null
): BaselineRecord | null {
  const attribution = manifest?.attribution;
  if (
    !attribution ||
    !Array.isArray(manifest.owned) ||
    !Array.isArray(attribution.entityTypes) ||
    !Array.isArray(attribution.relationshipTypes) ||
    !Array.isArray(attribution.automations)
  ) {
    return null;
  }
  return {
    attribution: {
      entityTypes: attribution.entityTypes,
      relationshipTypes: attribution.relationshipTypes,
      automations: attribution.automations,
    },
    owned: manifest.owned,
    ...(manifest.connector_versions
      ? { connectorVersions: manifest.connector_versions }
      : {}),
  };
}

/**
 * Preserve whether attribution was absent or recorded as empty. The former
 * cannot prove ownership and must not enable three-way comparisons.
 */
export function toBaseline(record: BaselineRecord | null): Baseline {
  if (!record) {
    return {
      recorded: false,
      attribution: { entityTypes: [], relationshipTypes: [], automations: [] },
      owned: new Set<string>(),
    };
  }
  return {
    recorded: true,
    attribution: record.attribution as unknown as Baseline["attribution"],
    owned: new Set(record.owned),
    ...(record.connectorVersions
      ? { connectorVersions: record.connectorVersions }
      : {}),
  };
}

/**
 * The post-apply attribution snapshot + owned identities. Attribution records
 * the effective entity/rel/Automation state AFTER a successful apply — config's
 * declared values merged with preserved unmanaged facets (eventKinds /
 * viewTemplate / schemaExtras the config never declared) from the pre-apply
 * remote — so `remote == attribution` means "unchanged since last apply".
 *
 * Under `prune`, omitted clearable facets are cleared by executePlan, so the
 * baseline must record the cleared value (not the pre-apply remote). Recording
 * the pre-apply remote left the next config-expressed delete blocked as
 * "post-baseline edit" forever.
 *
 * `owned` records the incarnation ids of definitions this config applied
 * (delete-eligible); creates with no known id are conservatively omitted
 * (they block as drift instead of auto-deleting — fail-closed).
 */
export function buildAttributionAndOwned(
  state: DesiredState,
  remote: RemoteSnapshot,
  orgId?: string,
  prune = false
): BaselineRecord {
  // The list endpoints also return PUBLIC definitions from OTHER orgs — a
  // foreign same-slug row must never populate the baseline (it would replace
  // the target org's incarnation id and facets). Filter to the target org.
  const ownedEntityTypes =
    orgId === undefined
      ? remote.entityTypes
      : remote.entityTypes.filter(
          (e) => e.organization_id === orgId || e.organization_id === undefined
        );
  const ownedRelTypes =
    orgId === undefined
      ? remote.relationshipTypes
      : remote.relationshipTypes.filter(
          (r) => r.organization_id === orgId || r.organization_id === undefined
        );
  // The effective post-apply facets come from the SAME projections the drift
  // gate compares against (`diff.ts`) — a second copy here is what let the
  // baseline and the gate disagree about prune-managed facets.
  const remoteEntityBySlug = new Map(ownedEntityTypes.map((e) => [e.slug, e]));
  const entityTypes = state.memorySchema.entityTypes.map((d) => {
    const r = remoteEntityBySlug.get(d.slug);
    return {
      id: r?.id,
      slug: d.slug,
      ...effectiveEntityTypeAfterApply(d, r, prune),
    };
  });
  const remoteRelBySlug = new Map(ownedRelTypes.map((r) => [r.slug, r]));
  const relationshipTypes = state.memorySchema.relationshipTypes.map((d) => {
    const r = remoteRelBySlug.get(d.slug);
    return {
      id: r?.id,
      slug: d.slug,
      ...effectiveRelationshipTypeAfterApply(d, r),
    };
  });
  const remoteAutomationBySlug = new Map(
    remote.automations.map((w) => [w.slug, w])
  );
  // Effective remote after apply: declared fields from config, undeclared
  // optional fields preserved from the pre-apply remote (two-way apply only
  // writes declared Automation fields — see `diffAutomation`). Recording the
  // config-only shape left sources/skills/tags as undefined and made the next
  // apply permanently block as "remote moved".
  const automations = state.automations.map((d) => {
    const r = remoteAutomationBySlug.get(d.slug);
    // Same projection the gate compares against; only the wire key names differ
    // (the stored attribution is remote-shaped, `projectDesiredAutomation` is not).
    const p = projectDesiredAutomation(d, r);
    return {
      slug: d.slug,
      automation_id: r?.automation_id,
      managed_agent_id: p.agent,
      name: p.name,
      description: p.description,
      prompt: p.prompt,
      triggers: p.triggers,
      skills: p.skills,
      sources: p.sources,
      reactions_guidance: p.reactionsGuidance,
      device_worker_id: p.deviceWorkerId,
      min_cooldown_seconds: p.minCooldownSeconds,
      tags: p.tags,
      agent_kind: p.agentKind,
      // The three-way baseline must record the effective execution_config after
      // apply (including preserved remote keys), or a later model edit is
      // misclassified as "remote moved" blocking drift instead of an update.
      execution_config: automationExecutionConfig(
        d.model,
        r?.execution_config,
        d.executor
      ),
      outputs: p.outputs,
      classifiers: p.classifiers,
    };
  });
  const owned: string[] = [];
  for (const e of state.memorySchema.entityTypes) {
    const id = remoteEntityBySlug.get(e.slug)?.id;
    if (id !== undefined) owned.push(`entity-type:${id}`);
  }
  for (const r of state.memorySchema.relationshipTypes) {
    const id = remoteRelBySlug.get(r.slug)?.id;
    if (id !== undefined) owned.push(`relationship-type:${id}`);
  }
  for (const w of state.automations) {
    const id = remoteAutomationBySlug.get(w.slug)?.automation_id;
    if (id !== undefined) owned.push(`automation:${id}`);
  }
  // Connector definitions this config declared (or references through an
  // auth-profile/connection) and has installed — delete-eligible under prune.
  const appliedConnectorKeys = new Set<string>([
    ...(state.connectors.definitions
      .map((d) => d.key)
      .filter(Boolean) as string[]),
    ...state.connectors.authProfiles.map((p) => p.connector),
    ...state.connectors.connections.map((c) => c.connector),
  ]);
  for (const def of remote.connectorDefinitions) {
    if (
      def.installed &&
      def.id !== undefined &&
      appliedConnectorKeys.has(def.key)
    ) {
      owned.push(`connector-definition:${def.id}`);
    }
  }
  return {
    attribution: { entityTypes, relationshipTypes, automations },
    owned,
  };
}

/**
 * Build the stored deployment snapshot. `connectorVersions` maps each
 * config-declared connector key to the version active AFTER this apply
 * (`install_connector` responses / the refreshed catalog) — the pins
 * `lobu rollback` repoints to via `rollback_connector_version`.
 */
export function buildDeploymentManifest(
  state: DesiredState,
  connectorVersions: Record<string, string>,
  baseline?: BaselineRecord
): DeploymentManifest {
  const redacted = redactDesiredState(state);
  const connectors = (redacted.connectors ?? {}) as Record<string, unknown>;
  const definitions = Array.isArray(connectors.definitions)
    ? (connectors.definitions as Array<Record<string, unknown>>)
    : [];
  return {
    version: SNAPSHOT_VERSION,
    state: {
      ...redacted,
      connectors: {
        ...connectors,
        // Keep the declaration shape for display/diff labels; drop the bytes.
        definitions: definitions.map(
          ({ sourceCode: _sourceCode, ...def }) => def
        ),
      },
    },
    connector_versions: connectorVersions,
    ...(baseline
      ? { attribution: baseline.attribution, owned: baseline.owned }
      : {}),
  };
}

export type CountsByKind = Record<
  string,
  { create?: number; update?: number; delete?: number }
>;

/** Per-resource-kind create/update/delete tallies for the summary payload. */
export function buildCountsByKind(rows: DiffRow[]): CountsByKind {
  const out: CountsByKind = {};
  for (const row of rows) {
    if (row.verb !== "create" && row.verb !== "update" && row.verb !== "delete")
      continue;
    const key = row.kind;
    const bucket = out[key] ?? {};
    out[key] = bucket;
    bucket[row.verb] = (bucket[row.verb] ?? 0) + 1;
  }
  return out;
}

export interface DeploymentSummary {
  apply_id: string;
  status: "succeeded" | "partial_failure" | "blocked";
  counts: DiffPlan["counts"];
  counts_by_kind: CountsByKind;
  manifest_hash: string;
  git_sha: string | null;
  git_dirty: boolean | null;
  cli_version: string | null;
  error?: string;
  /** Self-contained snapshot for `lobu rollback` (absent on legacy CLIs). */
  manifest?: DeploymentManifest;
  /** Blocking-drift candidates — present on `blocked` runs. */
  candidates?: {
    items: Array<{
      kind: string;
      slug: string;
      field?: string;
      action: "delete" | "revert";
    }>;
  };
  /** Set on rollback deployments: the deployment this one restored. */
  rollback_of?: string;
}
