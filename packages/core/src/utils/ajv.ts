/**
 * Shared AJV construction + error formatting.
 *
 * Both the server (schema-validation, event-kind-validation, operations input
 * validation) and the CLI (`lobu apply` connector-config validation) validate
 * runtime JSON Schemas with AJV. They kept separate, drifting singletons — the
 * server's hardened against a CWE-400 error-amplification DoS (`allErrors:false`,
 * see below), the CLI's not. This is the single source for the setup.
 *
 * `createAjv` takes the options rather than hard-coding one config: the server
 * and CLI make genuinely different, intentional choices (the server coerces
 * types and fails fast on untrusted remote input; the CLI reports every error
 * for a friendlier `lobu apply` on the operator's own local config). Sharing the
 * factory + formatter removes the duplicated dependency wiring without forcing
 * either caller to inherit the other's trade-offs.
 *
 * On `allErrors`: these instances validate UNTRUSTED metadata from agent tool
 * calls and the public REST surface. With `allErrors: true` an adversary can
 * craft an object that forces AJV to allocate an unbounded number of error
 * objects (CWE-400 / CodeQL `js/resource-exhaustion-from-deep-object-traversal`).
 * The server therefore passes `allErrors: false` (fail-fast) and additionally
 * bounds inputs before validating. Callers over trusted/local input (the CLI)
 * may opt into `allErrors: true` for fuller diagnostics.
 */

import Ajv, { type ErrorObject, type Options } from "ajv";
import addFormats from "ajv-formats";

/**
 * Build a configured AJV instance with the standard formats registered. Pass
 * the options that fit the call site's threat model (see module doc); nothing
 * is defaulted for you so the choice stays explicit at each construction site.
 */
export function createAjv(options: Options): Ajv {
  const ajv = new Ajv(options);
  addFormats(ajv);
  return ajv;
}

/** Render one AJV error into a human-readable, field-prefixed message. */
export function formatAjvError(error: ErrorObject): string {
  const field = error.instancePath
    ? error.instancePath.replace(/^\//, "")
    : "root";
  switch (error.keyword) {
    case "type":
      return `${field}: must be ${error.params.type}`;
    case "required":
      // A nested object reports `required` at the object's own path; name the
      // field from the root so `ref/backend_node_id` is not read as `backend_node_id`.
      return `missing required field: ${error.instancePath ? `${field}/` : ""}${error.params.missingProperty}`;
    case "format":
      return `${field}: must be a valid ${error.params.format}`;
    case "minimum":
      return `${field}: must be >= ${error.params.limit}`;
    case "maximum":
      return `${field}: must be <= ${error.params.limit}`;
    case "minLength":
      return `${field}: must be at least ${error.params.limit} characters`;
    case "maxLength":
      return `${field}: must be at most ${error.params.limit} characters`;
    case "pattern":
      return `${field}: must match pattern ${error.params.pattern}`;
    case "enum":
      return `${field}: must be one of: ${(error.params.allowedValues as string[]).join(", ")}`;
    case "additionalProperties":
      return `${field}: unknown property '${error.params.additionalProperty}'`;
    default:
      return error.message ?? `${field}: validation failed`;
  }
}
