/**
 * Agent Plugins root `mcp.json` validation — pure domain logic (C-1).
 *
 * Validates an already-parsed root `mcp.json` object against the pinned,
 * closed Agent Plugins v1 `mcp.json` schema (`AGENT_PLUGIN_MCP_SCHEMA`).
 * This is the SEPARATE MCP validation call the U1 docs describe:
 * `validateAgentPluginManifest` validates `plugin.json` only, and the caller
 * (U4 authoring, via `@ai-primitives-hub/app`) validates a standalone
 * `mcp.json` here.
 *
 * No filesystem/network access: the caller reads the file from disk and
 * passes the parsed object here. Mirrors the ajv wiring style of
 * `agent-plugin/validate.ts` (compile-once at module load, map each ajv
 * error to a plain string with the path embedded) using the draft-2020-12
 * Ajv build.
 * @module domain/agent-plugin/validate-mcp
 */
import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import agentPluginMcpSchema from '../../public/schemas/agent-plugin-mcp.schema.json';
import type {
  ValidationResult,
} from '../source/types';
import type {
  AgentPluginValidationMode,
} from './validate';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});
addFormats(ajv);
const validateSchema: ValidateFunction = ajv.compile(agentPluginMcpSchema);

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
 * Validate an already-parsed Agent Plugins root `mcp.json` object.
 *
 * Pure and dependency-free of I/O (C-1); the same input always yields the
 * same result. A non-object root is fatal in both modes. All other schema
 * violations fail only strict mode; in resilient mode they are reported as
 * warnings while the result stays valid (invariant: `valid=true` implies
 * `errors` is empty). The v1 `mcp.json` has no required top-level fields, so
 * an empty object is valid.
 * @param mcp - The parsed `mcp.json` candidate (untrusted).
 * @param mode - `strict` (authoring) rejects on any issue; `resilient` (consume) rejects only on a non-object root.
 * @returns A {@link ValidationResult} with plain-string messages (path embedded).
 */
export function validateAgentPluginMcp(
  mcp: unknown,
  mode: AgentPluginValidationMode
): ValidationResult {
  const record = asPlainObject(mcp);
  if (record === undefined) {
    return { valid: false, errors: ['root: not an object'] };
  }

  const issues: string[] = [];
  if (!validateSchema(record)) {
    for (const error of validateSchema.errors ?? []) {
      issues.push(formatSchemaError(error));
    }
  }

  if (mode === 'strict') {
    return { valid: issues.length === 0, errors: issues };
  }

  // resilient: schema issues are non-fatal warnings; the object still parses.
  const result: ValidationResult = { valid: true, errors: [] };
  if (issues.length > 0) {
    result.warnings = issues;
  }
  return result;
}
