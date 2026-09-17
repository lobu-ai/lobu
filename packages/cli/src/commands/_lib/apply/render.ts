import chalk from "chalk";
import type { BlockingDriftRow, DiffPlan, DiffRow } from "./diff.js";

const VERB_PREFIX = {
  create: chalk.green("+"),
  update: chalk.yellow("~"),
  noop: chalk.dim("="),
  drift: chalk.cyan("?"),
  delete: chalk.red("-"),
} as const;

const KIND_LABEL: Record<DiffRow["kind"], string> = {
  agent: "agent",
  settings: "settings",
  "entity-type": "entity-type",
  "relationship-type": "relationship-type",
  automation: "automation",
  "connector-definition": "connector-definition",
  view: "view",
  "auth-profile": "auth-profile",
  connection: "connection",
  feed: "feed",
  "inference-provider": "provider",
};

const KIND_HEADING: Record<DiffRow["kind"], string> = {
  agent: "agents",
  settings: "settings",
  "entity-type": "entity-types",
  "relationship-type": "relationship-types",
  automation: "automations",
  "connector-definition": "connector-definitions",
  view: "views",
  "auth-profile": "auth-profiles",
  connection: "connections",
  feed: "feeds",
  "inference-provider": "providers",
};

function fieldsList(fields: string[] | undefined): string {
  if (!fields?.length) return "";
  return chalk.dim(` (${fields.join(", ")})`);
}

/**
 * One-line preview of a value for the plan. Objects and arrays are the common
 * case (a property schema, an eventKinds list), so they are compacted rather
 * than pretty-printed — the plan is a scannable summary, and an operator who
 * needs the full body has the config and the dashboard.
 */
const VALUE_PREVIEW_MAX = 72;
function valuePreview(value: unknown): string {
  if (value === undefined) return chalk.dim("(unset)");
  const text = JSON.stringify(value) ?? String(value);
  return text.length > VALUE_PREVIEW_MAX
    ? `${text.slice(0, VALUE_PREVIEW_MAX - 1)}…`
    : text;
}

/**
 * `field: <remote> → <config>` lines under an update row, so the operator can
 * see what the apply overwrites instead of only which field names move. Absent
 * on rows from the two-way paths, which never computed the pair.
 */
function changedValueLines(
  changed: Array<{ field: string; from: unknown; to: unknown }> | undefined
): string[] {
  if (!changed?.length) return [];
  return changed.map(
    (c) =>
      `      ${chalk.cyan(c.field)}: ${chalk.dim(valuePreview(c.from))} → ${valuePreview(c.to)}`
  );
}

function rowId(row: DiffRow): string {
  if (
    row.kind === "connector-definition" &&
    row.desired?.key &&
    row.desired.sourcePath
  ) {
    return `${row.desired.key} (from ${row.desired.sourceFile})`;
  }
  if (row.kind === "connector-definition" && row.desired) {
    return row.desired.sourceUrl
      ? `${row.desired.sourceFile} (${row.desired.sourceUrl})`
      : row.desired.sourceFile;
  }
  return row.id;
}

function renderRow(row: DiffRow): string[] {
  const prefix = VERB_PREFIX[row.verb];
  const label = chalk.bold(KIND_LABEL[row.kind]);
  const id = rowId(row);
  const lines: string[] = [];

  switch (row.verb) {
    case "create":
      lines.push(`  ${prefix} ${label} ${id}`);
      if (
        row.kind === "connector-definition" &&
        row.installedRemotely &&
        row.desired?.key
      ) {
        lines.push(
          `      ${chalk.dim("(already installed — apply re-pushes source; no-op if unchanged)")}`
        );
      }
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth — complete it via the connect URL printed after apply`
        );
      }
      break;
    case "update": {
      const changedValues =
        "changedValues" in row ? row.changedValues : undefined;
      const previewedFields = new Set(
        changedValues?.map((change) => change.field) ?? []
      );
      const unpreviewedFields =
        "changedFields" in row
          ? row.changedFields?.filter((field) => !previewedFields.has(field))
          : undefined;
      lines.push(`  ${prefix} ${label} ${id}${fieldsList(unpreviewedFields)}`);
      lines.push(...changedValueLines(changedValues));
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth — complete it via the connect URL printed after apply`
        );
      }
      break;
    }
    case "noop":
      lines.push(`  ${prefix} ${label} ${id}`);
      if (row.kind === "auth-profile" && row.needsAuth) {
        lines.push(
          `      ${chalk.yellow("⚠")} interactive auth still pending — complete it via the connect URL printed after apply`
        );
      }
      break;
    case "drift":
      lines.push(
        "blocking" in row && row.blocking
          ? `  ${prefix} ${label} ${id} ${chalk.red("(remote change not in config — blocks this apply)")}`
          : `  ${prefix} ${label} ${id} ${chalk.cyan("(drift — ignored, not deleted)")}`
      );
      break;
    case "delete":
      lines.push(
        `  ${prefix} ${label} ${id} ${chalk.red("(removed from config — will be deleted)")}`
      );
      break;
  }

  return lines;
}

/** Emit the plan summary block — what `--dry-run` and the prompt-confirm phase show. */
export function renderPlan(plan: DiffPlan): string {
  const lines: string[] = [];
  lines.push(chalk.bold("\nPlan:"));

  // Group rows by kind so the output order is deterministic and readable.
  const order: DiffRow["kind"][] = [
    "agent",
    "settings",
    "entity-type",
    "relationship-type",
    "automation",
    "connector-definition",
    "auth-profile",
    "connection",
    "feed",
    "inference-provider",
  ];
  for (const kind of order) {
    const rowsForKind = plan.rows.filter((row) => row.kind === kind);
    if (rowsForKind.length === 0) continue;
    lines.push("");
    lines.push(chalk.bold(`  ${KIND_HEADING[kind]}:`));
    for (const row of rowsForKind) {
      lines.push(...renderRow(row));
    }
  }

  const notes = plan.notes ?? [];
  if (notes.length > 0) {
    lines.push("");
    lines.push(chalk.bold("  Notes:"));
    for (const note of notes) {
      lines.push(`  ${chalk.cyan("•")} ${note}`);
    }
  }

  lines.push("");
  lines.push(renderSummary(plan));
  return lines.join("\n");
}

/** Post-apply punch-list: pending interactive auth + informational notes. */
export function renderPostApplyPunchList(items: {
  pendingAuth: Array<{ slug: string; kind: string; connectUrl?: string }>;
  notes: string[];
}): string | null {
  if (items.pendingAuth.length === 0 && items.notes.length === 0) return null;
  const lines: string[] = [chalk.bold("\nNext steps:")];
  for (const item of items.pendingAuth) {
    if (item.connectUrl) {
      lines.push(
        `  ${chalk.yellow("→")} auth profile ${chalk.bold(item.slug)} (${item.kind}) needs authorization: ${chalk.underline(item.connectUrl)}`
      );
    } else {
      lines.push(
        `  ${chalk.yellow("→")} auth profile ${chalk.bold(item.slug)} (${item.kind}) needs a session — set it up in the connections UI`
      );
    }
  }
  for (const note of items.notes) {
    lines.push(`  ${chalk.cyan("•")} ${note}`);
  }
  return lines.join("\n");
}

export function renderSummary(plan: DiffPlan): string {
  const { create, update, noop, drift, delete: del } = plan.counts;
  // `delete` only appears for code-managed orgs; omit it otherwise so the
  // common UI-managed summary stays unchanged.
  const deletePart = del > 0 ? `, ${chalk.red(`${del} delete`)}` : "";
  return chalk.bold(
    `Summary: ${chalk.green(`${create} create`)}, ${chalk.yellow(`${update} update`)}, ${chalk.dim(`${noop} noop`)}, ${chalk.cyan(`${drift} drift`)}${deletePart}`
  );
}

/** Apply-time progress line. Mirrors the same prefix as the plan rows. */
export function renderProgress(
  verb: DiffRow["verb"],
  kind: DiffRow["kind"],
  id: string,
  detail?: string
): string {
  const prefix = VERB_PREFIX[verb];
  const label = chalk.bold(KIND_LABEL[kind]);
  const tail = detail ? chalk.dim(` ${detail}`) : "";
  return `  ${prefix} ${label} ${id}${tail}`;
}

/**
 * Blocked-report value. Unlike the plan's one-liner this stays pretty-printed —
 * the report is the artifact an operator reads carefully to resolve the drift,
 * so a truncated schema body would be the wrong trade there.
 */
function blockedValue(value: unknown, absentLabel: string): string {
  if (value === undefined) return chalk.dim(absentLabel);
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.split("\n").join("\n    ");
}

/**
 * The blocking-drift report shown when apply halts (exit 1, nothing mutated).
 * Names each remote-moved field / remote-only definition and the resolution.
 */
export function renderBlockedReport(blocking: BlockingDriftRow[]): string {
  const lines = [
    "",
    chalk.red(
      `✖ BLOCKED — ${blocking.length} remote change${blocking.length === 1 ? "" : "s"} not declared in this config`
    ),
    chalk.dim(
      "  apply would clobber or delete un-declared remote state. Nothing was changed."
    ),
  ];
  for (const item of blocking) {
    const label = chalk.bold(KIND_LABEL[item.kind]);
    const field = item.field ? chalk.cyan(` · ${item.field}`) : "";
    lines.push("");
    lines.push(`  ${label} ${item.id}${field}`);
    // Checking only `remoteChange` would hide both sides when the remote value
    // is absent but the config still declares one.
    if (item.remoteChange !== undefined || item.desiredChange !== undefined) {
      lines.push(`    remote: ${blockedValue(item.remoteChange, "(absent)")}`);
      lines.push(
        `    config: ${blockedValue(item.desiredChange, "(not declared)")}`
      );
    }
  }
  lines.push(
    "",
    chalk.dim("  Resolve each item, then re-run:"),
    chalk.dim("    adopt  → fold it into lobu.config.ts (a normal git change)"),
    chalk.dim("    delete → remove it in the UI, or via the API"),
    chalk.dim("  apply refuses to auto-delete or overwrite un-declared state.")
  );
  return lines.join("\n");
}

/** Required-secrets-missing block. */
export function renderMissingSecrets(missing: string[]): string {
  const lines = [
    chalk.red(
      `\n  Missing ${missing.length} required secret${missing.length === 1 ? "" : "s"}:`
    ),
  ];
  for (const name of missing) lines.push(chalk.red(`    - $${name}`));
  lines.push(
    chalk.dim(
      "\n  These env vars are referenced in lobu.config.ts but are not set in the current environment."
    )
  );
  lines.push(
    chalk.dim(
      "  Set them locally (e.g. via .env) or via your deployment's secret manager and retry."
    )
  );
  return lines.join("\n");
}
