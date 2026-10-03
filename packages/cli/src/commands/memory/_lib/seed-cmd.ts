import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  DesiredEntityType,
  DesiredRelationshipType,
} from "../../_lib/apply/desired-state.js";
import { loadDesiredStateFromConfig } from "../../_lib/apply/desired-state.js";
import { isPlatformOwnedRelationshipSlug } from "../../_lib/platform-owned-types.js";
import { ApiError, ValidationError, wrongHostHint } from "./errors.js";
import {
  getSessionForOrg,
  getUsableToken,
  mcpUrlForOrg,
  orgFromMcpUrl,
  resolveOrg,
  resolveServerUrl,
} from "./memory-auth.js";
import { printError, printText } from "../../../internal/output.js";
import {
  type DataRecordType,
  type ValidationError as SchemaError,
  type SeedEntitySchema,
  type SeedRelationshipSchema,
  validateDataRecord,
} from "./schema.js";

interface SeedContext {
  apiBaseUrl: string;
  orgSlug: string;
  token: string;
  dryRun: boolean;
}

interface ParsedDataRecord {
  data: Record<string, unknown>;
  file: string;
  recordType: DataRecordType;
}

/**
 * Where seed reads from: the project's `lobu.config.ts` (schema + org) plus an
 * optional `./data` directory of YAML data records to instantiate.
 */
interface ProjectLayout {
  cwd: string;
  configPath: string;
  dataPath: string;
  org: string;
  name: string;
}

function readYamlFilesRecursive(
  dir: string,
  prefix = ""
): Array<{ data: Record<string, unknown>; file: string }> {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relPath = prefix ? join(prefix, entry.name) : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        return readYamlFilesRecursive(fullPath, relPath);
      }
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))
      ) {
        return [];
      }
      return [
        {
          data: parseYaml(readFileSync(fullPath, "utf8")) as Record<
            string,
            unknown
          >,
          file: relPath,
        },
      ];
    });
}

function checkErrors(errors: SchemaError[]): void {
  if (errors.length > 0) {
    for (const e of errors) {
      printError(`  ${e.file}: ${e.field} — ${e.message}`);
    }
    throw new ValidationError(
      `Schema validation failed (${errors.length} error${errors.length > 1 ? "s" : ""})`
    );
  }
}

/**
 * Resolve the project + its desired state from `lobu.config.ts`. Entity types,
 * relationship types, and org metadata come from the config (the same source
 * `lobu apply` uses); `./data` holds the YAML data records to instantiate.
 */
async function resolveProjectLayout(inputPath?: string): Promise<{
  layout: ProjectLayout;
  state: Awaited<ReturnType<typeof loadDesiredStateFromConfig>>["state"];
}> {
  const requested = resolve(inputPath || ".");
  let cwd: string;
  if (existsSync(requested) && statSync(requested).isFile()) {
    if (basename(requested) !== "lobu.config.ts") {
      throw new ValidationError(
        `Expected a lobu.config.ts file, got ${basename(requested)}`
      );
    }
    cwd = dirname(requested);
  } else {
    cwd = requested;
  }

  const { state, configPath } = await loadDesiredStateFromConfig({ cwd });
  const org = state.memory?.org?.trim() ?? "";
  if (!org) {
    throw new ValidationError(
      "lobu.config.ts must set `org` in defineConfig({ org: ... }) to seed memory"
    );
  }
  const name = state.memory?.name?.trim() || org;
  const dataPath = resolve(cwd, "data");
  return { layout: { cwd, configPath, dataPath, org, name }, state };
}

function loadDataRecords(dataPath: string): ParsedDataRecord[] {
  const entries = readYamlFilesRecursive(dataPath);
  for (const { data, file } of entries) {
    checkErrors(validateDataRecord(data, file));
  }
  return entries.map(({ data, file }) => ({
    data,
    file,
    recordType: data.type as DataRecordType,
  }));
}

function deriveApiBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export async function callTool(
  ctx: SeedContext,
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = `${ctx.apiBaseUrl}/api/${ctx.orgSlug}/${toolName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.token}`,
    },
    body: JSON.stringify(args),
  });

  const body = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body is most often a wrong-host answer (405/404 from
    // a host that does not serve the tool API). Name the URL and status so the
    // failure is diagnosable instead of a bare "Invalid JSON".
    const detail = body.trim()
      ? body.slice(0, 500)
      : `HTTP ${res.status} ${res.statusText}`.trim();
    throw new ApiError(
      res.ok
        ? `Invalid JSON from ${toolName} via ${url}: ${detail}`
        : `${toolName} failed via ${url}: ${detail}${wrongHostHint(res.status)}`,
      res.status
    );
  }

  if (!res.ok) {
    const msg =
      typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }

  return parsed;
}

async function seedEntity(
  entity: DesiredEntityType,
  ctx: SeedContext
): Promise<void> {
  const slug = entity.slug;
  if (ctx.dryRun) {
    printText(`  [dry-run] would create entity_type: ${slug}`);
    return;
  }
  // Same payload `lobu apply` sends to manage_entity_schema (upsertEntityType).
  // The server stores per-type fields as a single `metadata_schema` JSON Schema
  // and ignores top-level `properties`/`required`, so fold them in here too.
  const payload: Record<string, unknown> = {
    schema_type: "entity_type",
    action: "create",
    slug: entity.slug,
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.description ? { description: entity.description } : {}),
  };
  if (entity.properties !== undefined || entity.required !== undefined) {
    payload.metadata_schema = {
      type: "object",
      properties: entity.properties ?? {},
      ...(entity.required && entity.required.length > 0
        ? { required: entity.required }
        : {}),
    };
  }
  try {
    await callTool(ctx, "manage_entity_schema", payload);
    printText(`  + entity_type: ${slug}`);
  } catch (e) {
    if (e instanceof Error && e.message?.includes("already exists")) {
      printText(`  = entity_type: ${slug} (exists)`);
    } else {
      throw e;
    }
  }
}

async function seedRelationshipType(
  rel: DesiredRelationshipType,
  ctx: SeedContext
): Promise<void> {
  const slug = rel.slug;
  const rules = rel.rules ?? [];
  // Rules are registered via separate add_rule calls — the create handler
  // doesn't accept them inline.
  const createPayload = {
    schema_type: "relationship_type",
    slug: rel.slug,
    ...(rel.name ? { name: rel.name } : {}),
    ...(rel.description ? { description: rel.description } : {}),
  };

  if (ctx.dryRun) {
    printText(`  [dry-run] would create relationship_type: ${slug}`);
    for (const rule of rules) {
      printText(`  [dry-run]   + rule: ${rule.source} -> ${rule.target}`);
    }
    return;
  }
  try {
    await callTool(ctx, "manage_entity_schema", {
      ...createPayload,
      action: "create",
    });
    printText(`  + relationship_type: ${slug}`);
  } catch (e) {
    if (e instanceof Error && e.message?.includes("already exists")) {
      await callTool(ctx, "manage_entity_schema", {
        ...createPayload,
        action: "update",
      });
      printText(`  = relationship_type: ${slug} (updated)`);
    } else {
      throw e;
    }
  }

  for (const rule of rules) {
    const source = String(rule.source ?? "");
    const target = String(rule.target ?? "");
    if (!source || !target) continue;
    try {
      await callTool(ctx, "manage_entity_schema", {
        schema_type: "relationship_type",
        action: "add_rule",
        slug,
        source_entity_type_slug: source,
        target_entity_type_slug: target,
      });
      printText(`    + rule: ${source} -> ${target}`);
    } catch (e) {
      if (e instanceof Error && e.message?.includes("already exists")) {
        printText(`    = rule: ${source} -> ${target} (exists)`);
      } else {
        throw e;
      }
    }
  }
}

function addEntityRef(
  entityMap: Map<string, number>,
  entity: { id: number; slug: string; entity_type: string }
) {
  entityMap.set(entity.slug, entity.id);
  entityMap.set(`${entity.entity_type}:${entity.slug}`, entity.id);
}

function resolveEntityRef(
  entityMap: Map<string, number>,
  ref: string
): number | null {
  return entityMap.get(ref) ?? null;
}

async function loadEntityMap(
  ctx: SeedContext,
  entityTypes: string[]
): Promise<Map<string, number>> {
  const entityMap = new Map<string, number>();
  const uniqueTypes = Array.from(new Set(entityTypes.filter(Boolean))).sort();
  const PAGE_SIZE = 500;

  for (const entityType of uniqueTypes) {
    let offset = 0;
    while (true) {
      const result = await callTool(ctx, "manage_entity", {
        action: "list",
        entity_type: entityType,
        limit: PAGE_SIZE,
        offset,
      });
      const entities = (result.entities || []) as Array<{
        id: number;
        slug: string;
        entity_type: string;
      }>;
      for (const entity of entities) {
        addEntityRef(entityMap, entity);
      }
      if (entities.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return entityMap;
}

async function seedDataEntity(
  entity: SeedEntitySchema,
  entityMap: Map<string, number>,
  ctx: SeedContext
): Promise<boolean> {
  if (ctx.dryRun) {
    if (entity.parent && !resolveEntityRef(entityMap, entity.parent)) {
      printError(
        `  ! entity: ${entity.slug} - unknown parent "${entity.parent}", will retry`
      );
      return false;
    }
    const placeholderId = -(entityMap.size + 1);
    addEntityRef(entityMap, {
      id: placeholderId,
      slug: entity.slug,
      entity_type: entity.entity_type,
    });
    printText(`  [dry-run] would create entity: ${entity.slug}`);
    return true;
  }

  const payload: Record<string, unknown> = {
    action: "create",
    entity_type: entity.entity_type,
    slug: entity.slug,
    name: entity.name,
  };
  if (entity.content) payload.content = entity.content;
  if (entity.metadata) payload.metadata = entity.metadata;
  if (entity.parent) {
    const parentId = resolveEntityRef(entityMap, entity.parent);
    if (!parentId) {
      printError(
        `  ! entity: ${entity.slug} - unknown parent "${entity.parent}", will retry`
      );
      return false;
    }
    payload.parent_id = parentId;
  }

  try {
    const result = await callTool(ctx, "manage_entity", payload);
    const created = result.entity as
      | { id: number; slug: string; entity_type: string }
      | undefined;
    if (created) {
      addEntityRef(entityMap, created);
    }
    printText(`  + entity: ${entity.slug}`);
    return true;
  } catch (e) {
    if (e instanceof Error && e.message?.includes("already exists")) {
      printText(`  = entity: ${entity.slug} (exists)`);
      return true;
    }
    throw e;
  }
}

async function seedDataRelationship(
  relationship: SeedRelationshipSchema,
  entityMap: Map<string, number>,
  ctx: SeedContext
): Promise<boolean> {
  const fromId = resolveEntityRef(entityMap, relationship.from);
  const toId = resolveEntityRef(entityMap, relationship.to);
  if (!fromId || !toId) {
    printError(
      `  ! relationship: ${relationship.relationship_type} - unresolved refs from="${relationship.from}" to="${relationship.to}", skipping`
    );
    return false;
  }

  if (ctx.dryRun) {
    printText(
      `  [dry-run] would create relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to})`
    );
    return true;
  }

  try {
    await callTool(ctx, "manage_entity", {
      action: "link",
      from_entity_id: fromId,
      to_entity_id: toId,
      relationship_type_slug: relationship.relationship_type,
      ...(relationship.metadata ? { metadata: relationship.metadata } : {}),
      ...(relationship.confidence !== undefined
        ? { confidence: relationship.confidence }
        : {}),
      ...(relationship.source ? { source: relationship.source } : {}),
    });
    printText(
      `  + relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to})`
    );
    return true;
  } catch (e) {
    if (e instanceof Error && e.message?.includes("already exists")) {
      printText(
        `  = relationship: ${relationship.relationship_type} (${relationship.from} -> ${relationship.to}) (exists)`
      );
      return true;
    }
    throw e;
  }
}

async function resolveAuth(
  urlFlag?: string,
  orgFlag?: string,
  context?: string
): Promise<{ token: string; mcpUrl: string; orgSlug: string }> {
  const org = await resolveOrg(orgFlag, undefined, context);

  if (org) {
    const orgSession = await getSessionForOrg(org, context, urlFlag);
    if (orgSession) {
      const result = await getUsableToken(orgSession.key, context);
      if (result) {
        return { token: result.token, mcpUrl: orgSession.key, orgSlug: org };
      }
    }
    const serverUrl = await resolveServerUrl(urlFlag, context);
    if (serverUrl) {
      const orgUrl = mcpUrlForOrg(serverUrl, org);
      const result = await getUsableToken(orgUrl, context);
      if (result) {
        return { token: result.token, mcpUrl: orgUrl, orgSlug: org };
      }
    }
    throw new ValidationError("Not logged in. Run: lobu login");
  }

  const serverUrl = await resolveServerUrl(urlFlag, context);
  const result = await getUsableToken(serverUrl || undefined, context);
  if (!result) {
    throw new ValidationError("Not logged in. Run: lobu login");
  }

  const resolvedOrg =
    orgFromMcpUrl(result.session.mcpUrl) || result.session.org;
  if (!resolvedOrg) {
    throw new ValidationError(
      "Cannot determine org. Use --org or set LOBU_MEMORY_ORG."
    );
  }

  return {
    token: result.token,
    mcpUrl: result.session.mcpUrl,
    orgSlug: resolvedOrg,
  };
}

export interface SeedOptions {
  path?: string;
  dryRun?: boolean;
  org?: string;
  url?: string;
  context?: string;
}

export async function seedMemoryWorkspace(
  opts: SeedOptions = {}
): Promise<void> {
  const { layout, state } = await resolveProjectLayout(opts.path);

  const orgOverride = opts.org || layout.org;
  const { token, mcpUrl, orgSlug } = await resolveAuth(
    opts.url,
    orgOverride,
    opts.context
  );
  const apiBaseUrl = deriveApiBaseUrl(mcpUrl);
  const dryRun = opts.dryRun ?? false;
  const ctx: SeedContext = { apiBaseUrl, orgSlug, token, dryRun };

  printText(`Seeding org: ${orgSlug}${dryRun ? " (dry-run)" : ""}`);
  printText(`Config: ${layout.configPath}`);
  printText(`Project: ${layout.name}`);

  // Schema (entity types / relationship types) comes from lobu.config.ts — the
  // same source `lobu apply` provisions from; seeding here is idempotent.
  // Automations are agent-scoped and provisioned by `lobu apply`, not seeded.
  const entityTypes = state.memorySchema.entityTypes;
  const relationshipTypes = state.memorySchema.relationshipTypes;
  const dataRecords = loadDataRecords(layout.dataPath);

  const dataEntities = dataRecords.filter(
    (record): record is ParsedDataRecord & { data: SeedEntitySchema } =>
      record.recordType === "entity"
  );
  const dataRelationships = dataRecords.filter(
    (record): record is ParsedDataRecord & { data: SeedRelationshipSchema } =>
      record.recordType === "relationship"
  );

  if (entityTypes.length > 0) {
    printText(`\nEntity types (${entityTypes.length}):`);
    for (const entity of entityTypes) {
      await seedEntity(entity, ctx);
    }
  }

  // Platform-owned slugs are skipped for the same reason apply skips them: the
  // create returns "already exists", the fallback issues an update, and the
  // schema surface rejects that outright once the type is classified as
  // authorization-bearing — aborting the whole seed for any config declaring one.
  const seedableRelationshipTypes = relationshipTypes.filter(
    (rel) => !isPlatformOwnedRelationshipSlug(rel.slug)
  );
  if (seedableRelationshipTypes.length > 0) {
    printText(`\nRelationship types (${seedableRelationshipTypes.length}):`);
    for (const rel of seedableRelationshipTypes) {
      await seedRelationshipType(rel, ctx);
    }
  }

  const entityTypesForLookup = Array.from(
    new Set([
      ...entityTypes.map((entry) => entry.slug),
      ...dataEntities.map((entry) => entry.data.entity_type),
    ])
  );
  const entityMap = dryRun
    ? new Map<string, number>()
    : await loadEntityMap(ctx, entityTypesForLookup);

  if (dataEntities.length > 0) {
    printText(`\nData entities (${dataEntities.length}):`);
    let pending = [...dataEntities];
    let previousPendingCount = Number.POSITIVE_INFINITY;
    while (pending.length > 0 && pending.length < previousPendingCount) {
      previousPendingCount = pending.length;
      const nextPending: typeof pending = [];
      for (const entry of pending) {
        const resolved = await seedDataEntity(entry.data, entityMap, ctx);
        if (!resolved) {
          nextPending.push(entry);
        }
      }
      pending = nextPending;
    }
    for (const entry of pending) {
      printError(
        `  ! entity: ${entry.data.slug} - could not resolve dependencies, skipped`
      );
    }
  }

  if (dataRelationships.length > 0) {
    printText(`\nData relationships (${dataRelationships.length}):`);
    for (const entry of dataRelationships) {
      await seedDataRelationship(entry.data, entityMap, ctx);
    }
  }

  printText(dryRun ? "\nDry run complete." : "\nSeed complete.");
}
