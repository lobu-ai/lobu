import type { Options, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { createAjv, formatAjvError } from '@lobu/core/ajv';
import type { OperationDescriptor } from './types';
import { getErrorMessage } from '@lobu/core';

// Fail-fast over untrusted caller input (see the `allErrors` note in
// `@lobu/core/ajv`); both dialect instances share the same threat model.
const operationInputAjvOptions: Options = {
  allErrors: false,
  strict: false,
  coerceTypes: false,
};

const operationInputAjv = createAjv(operationInputAjvOptions);

// MCP tools can declare JSON Schema 2020-12. The draft-07 instance above has
// no meta-schema for that `$schema` and throws on compile, which rejected
// every call to such a tool. Compile those with the 2020-12 validator so its
// keywords (`prefixItems`, `items: false`, ...) stay enforced, while schemas
// that don't declare it keep their draft-07 semantics.
const operationInputAjv2020 = new Ajv2020(operationInputAjvOptions);
addFormats(operationInputAjv2020);

// `input_schema` objects are parsed fresh from the DB on each request (no
// `$id`), so AJV can't dedupe them and `compile()` would add a new validator
// to the instance's internal store on every call, growing without bound on a
// long-lived gateway. Cache the compiled validator keyed on the serialized
// schema: identical schemas reuse one validator (capping growth at the number
// of distinct schemas), while an updated schema for the same operation still
// gets its own validator.
const validatorCache = new Map<string, ValidateFunction>();

export function validateOperationInput(
  operation: OperationDescriptor,
  input: Record<string, unknown>
): string | null {
  const schema = operation.input_schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;

  try {
    const cacheKey = JSON.stringify(schema);
    let validate = validatorCache.get(cacheKey);
    if (!validate) {
      const ajv = schema.$schema === 'https://json-schema.org/draft/2020-12/schema'
        || schema.$schema === 'https://json-schema.org/draft/2020-12/schema#'
        ? operationInputAjv2020
        : operationInputAjv;
      validate = ajv.compile(schema);
      validatorCache.set(cacheKey, validate);
    }
    if (validate(input)) return null;
    const firstError = validate.errors?.[0];
    return firstError
      ? formatAjvError(firstError)
      : 'input does not match operation schema';
  } catch (error) {
    return `operation input schema is invalid: ${getErrorMessage(error)}`;
  }
}
