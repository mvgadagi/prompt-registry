/**
 * Agent Plugins manifest validation — pure domain logic (C-1).
 *
 * Validates an already-parsed `plugin.json` object against the pinned,
 * closed Agent Plugins v1 schema plus the `name` grammar (R1). No
 * filesystem/network access: the caller (U2) reads the manifest from disk
 * and passes the parsed object here. MCP validation is a SEPARATE call the
 * caller makes against `AGENT_PLUGIN_MCP_SCHEMA`; this function validates the
 * `plugin.json` object only.
 *
 * Mirrors the ajv wiring style of `infra/src/hub/validate-hub-config.ts`
 * (compile-once at module load, map each ajv error to a plain string with
 * the path embedded), using the draft-2020-12 Ajv build.
 * @module domain/agent-plugin/validate
 */
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import agentPluginSchema from '../../public/schemas/agent-plugin.schema.json';
import type {
  ValidationResult,
} from '../source/types';

/** Validation strictness. Strict = authoring; resilient = consume (§11.3). */
export type AgentPluginValidationMode = 'strict' | 'resilient';

/** Lower and upper bounds for the `name` grammar (R1). */
export const AGENT_PLUGIN_NAME_MIN_LENGTH = 1;
export const AGENT_PLUGIN_NAME_MAX_LENGTH = 64;

/**
 * Anchored, character-class-only pattern for the `name` grammar. It has no
 * nested quantifiers and cannot backtrack catastrophically (SEC-U1-4): a
 * single leading alphanumeric, an optional run of allowed characters, and a
 * trailing alphanumeric. The `--`/`..` prohibition is checked separately via
 * a linear substring scan.
 */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});
addFormats(ajv);
const validateSchema: ValidateFunction = ajv.compile(agentPluginSchema);

/**
 * Narrow an unknown value to a plain (non-array, non-null) object.
 * @param value - Candidate value.
 * @returns The value as a record, or `undefined` if it is not a plain object.
 */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Validate the Agent Plugins `name` grammar (R1) in linear time.
 * @param name - The candidate name.
 * @returns A message describing the violation, or `null` when the name is well-formed.
 */
export function validateAgentPluginName(name: string): string | null {
  if (
    name.length < AGENT_PLUGIN_NAME_MIN_LENGTH
    || name.length > AGENT_PLUGIN_NAME_MAX_LENGTH
  ) {
    return `name: must be ${AGENT_PLUGIN_NAME_MIN_LENGTH}-${AGENT_PLUGIN_NAME_MAX_LENGTH} characters`;
  }
  if (!NAME_PATTERN.test(name)) {
    return "name: must be lowercase a-z, 0-9, '-' or '.', starting and ending with an alphanumeric character";
  }
  if (name.includes('--') || name.includes('..')) {
    return "name: must not contain consecutive '--' or '..'";
  }
  return null;
}

/**
 * Map a single ajv error to a plain string message with the path embedded.
 * @param error - An ajv error object.
 * @returns A human-readable, actionable message.
 */
function formatSchemaError(error: ErrorObject): string {
  const dataPath = error.instancePath || '$';
  const params = error.params as Record<string, unknown>;

  switch (error.keyword) {
    case 'additionalProperties': {
      return `${dataPath}: unknown field '${String(params.additionalProperty)}' is not allowed`;
    }
    case 'required': {
      return `${dataPath}: missing required property '${String(params.missingProperty)}'`;
    }
    default: {
      return `${dataPath}: ${error.message ?? 'validation failed'}`;
    }
  }
}

/**
 * Whether an ajv error duplicates a fatal top-level `$schema`/`name` issue
 * already recorded by the explicit required-field checks.
 * @param error - An ajv error object.
 * @returns `true` when the error should be skipped to avoid double-reporting.
 */
function isDuplicateFatalError(error: ErrorObject): boolean {
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    return error.instancePath === '' && (missing === '$schema' || missing === 'name');
  }
  if (error.keyword === 'type') {
    return error.instancePath === '/$schema' || error.instancePath === '/name';
  }
  return false;
}

/**
 * Validate an already-parsed Agent Plugins `plugin.json` object.
 *
 * Pure and dependency-free of I/O (C-1); same input always yields the same
 * result. Fatal issues (unparseable root, missing/mistyped `$schema` or
 * `name`) fail both modes. Non-fatal issues (unknown fields, malformed but
 * present `name`) fail only strict mode; in resilient mode they are reported
 * as warnings while the result stays valid (invariant: `valid=true` implies
 * `errors` is empty).
 * @param manifest - The parsed `plugin.json` candidate (untrusted).
 * @param mode - `strict` (authoring) rejects on any issue; `resilient` (consume) rejects only on a fatal issue.
 * @returns A {@link ValidationResult} with plain-string messages (path embedded).
 */
export function validateAgentPluginManifest(
  manifest: unknown,
  mode: AgentPluginValidationMode
): ValidationResult {
  // 1. Parse guard.
  const record = asPlainObject(manifest);
  if (record === undefined) {
    return { valid: false, errors: ['root: not an object'] };
  }

  const fatal: string[] = [];
  const nonFatal: string[] = [];

  // 2. Required top-level fields ($schema, name) — fatal in both modes.
  if (typeof record.$schema !== 'string') {
    fatal.push("$schema: required 'string' field is missing or not a string");
  }
  if (typeof record.name !== 'string') {
    fatal.push("name: required 'string' field is missing or not a string");
  }

  // 3. name grammar (R1) — non-fatal; only when name is a present string.
  if (typeof record.name === 'string') {
    const nameIssue = validateAgentPluginName(record.name);
    if (nameIssue !== null) {
      nonFatal.push(nameIssue);
    }
  }

  // 4. Closed-manifest schema validation — each violation is non-fatal
  //    (fatal missing/mistyped $schema/name already captured in step 2).
  const schemaValid = validateSchema(record);
  if (!schemaValid) {
    for (const error of validateSchema.errors ?? []) {
      if (isDuplicateFatalError(error)) {
        continue;
      }
      nonFatal.push(formatSchemaError(error));
    }
  }

  // 5. Mode branch.
  if (mode === 'strict') {
    const errors = [...fatal, ...nonFatal];
    return { valid: errors.length === 0, errors };
  }

  // resilient: fatal → errors[]; non-fatal → warnings[]; valid iff no fatal.
  const result: ValidationResult = {
    valid: fatal.length === 0,
    errors: fatal
  };
  if (nonFatal.length > 0) {
    result.warnings = nonFatal;
  }
  return result;
}
