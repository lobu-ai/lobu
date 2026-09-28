/**
 * Schema + validation for `lobu memory seed` data records (`./data/*.yaml` —
 * seed entity + relationship instances). Entity/relationship/automation *types*
 * are declared in `lobu.config.ts` (via `@lobu/cli/config`), not here.
 *
 * Bump CURRENT_SCHEMA_VERSION when making breaking changes.
 */

const CURRENT_SCHEMA_VERSION = 2;

export type DataRecordType = "entity" | "relationship";

// ── Seed data files ─────────────────────────────────────────────────

export interface SeedEntitySchema {
  version?: number;
  type: "entity";
  entity_type: string;
  slug: string;
  name: string;
  content?: string;
  parent?: string;
  metadata?: Record<string, unknown>;
}

export interface SeedRelationshipSchema {
  version?: number;
  type: "relationship";
  relationship_type: string;
  from: string;
  to: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: "ui" | "llm" | "feed" | "api";
}

// ── Validation ──────────────────────────────────────────────────────

export interface ValidationError {
  file: string;
  field: string;
  message: string;
}

function checkVersion(
  parsed: Record<string, unknown>,
  file: string,
  errors: ValidationError[]
): boolean {
  const v = parsed.version;
  if (v !== undefined && typeof v === "number" && v > CURRENT_SCHEMA_VERSION) {
    errors.push({
      file,
      field: "version",
      message: `version ${v} is not supported by this CLI (max: ${CURRENT_SCHEMA_VERSION}). Upgrade @lobu/cli.`,
    });
    return false;
  }
  return true;
}

function requireString(
  parsed: Record<string, unknown>,
  field: string,
  file: string,
  errors: ValidationError[]
): boolean {
  if (typeof parsed[field] !== "string" || parsed[field] === "") {
    errors.push({
      file,
      field,
      message: `"${field}" is required and must be a non-empty string`,
    });
    return false;
  }
  return true;
}

function requireObject(
  parsed: Record<string, unknown>,
  field: string,
  file: string,
  errors: ValidationError[]
): boolean {
  const value = parsed[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push({
      file,
      field,
      message: `"${field}" is required and must be an object`,
    });
    return false;
  }
  return true;
}

export function validateDataRecord(
  parsed: Record<string, unknown>,
  file: string
): ValidationError[] {
  const errors: ValidationError[] = [];
  checkVersion(parsed, file, errors);

  const recordType = parsed.type as string | undefined;
  if (!recordType || !["entity", "relationship"].includes(recordType)) {
    errors.push({
      file,
      field: "type",
      message: `"type" is required and must be one of: entity, relationship`,
    });
    return errors;
  }

  if (recordType === "entity") {
    requireString(parsed, "entity_type", file, errors);
    requireString(parsed, "slug", file, errors);
    requireString(parsed, "name", file, errors);
    if (parsed.metadata !== undefined) {
      requireObject(parsed, "metadata", file, errors);
    }
    return errors;
  }

  requireString(parsed, "relationship_type", file, errors);
  requireString(parsed, "from", file, errors);
  requireString(parsed, "to", file, errors);
  if (parsed.metadata !== undefined) {
    requireObject(parsed, "metadata", file, errors);
  }
  if (parsed.confidence !== undefined) {
    const confidence = parsed.confidence;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      errors.push({
        file,
        field: "confidence",
        message: '"confidence" must be a number between 0 and 1',
      });
    }
  }
  if (
    parsed.source !== undefined &&
    !["ui", "llm", "feed", "api"].includes(String(parsed.source))
  ) {
    errors.push({
      file,
      field: "source",
      message: '"source" must be one of: ui, llm, feed, api',
    });
  }

  return errors;
}
