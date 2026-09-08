/**
 * Agent Plugins v1 manifest parser (U2) — a net-new, pure sibling to
 * `harvest/plugin-manifest.ts`.
 *
 * This module turns an already-read root `plugin.json` (and, optionally, a
 * root `mcp.json`) plus a list of skills discovered under `skills/` into the
 * U1 `AgentPluginPackage` model. It is deliberately pure (no I/O, no
 * network): the two source adapters (`AgentPluginsSourceAdapter` /
 * `LocalAgentPluginsAdapter`) do the disk/GitHub enumeration and hand the
 * discovered inputs here, so the parser can be unit- and property-tested in
 * isolation (per the U2 functional design `business-logic-model.md`).
 *
 * Reuse boundary (ADR-2): only the JSON-parse guard (`parsePluginManifest`)
 * and the servers-only MCP fold (`extractPluginMcpServers`) transfer from
 * `plugin-manifest.ts`. The v1 root-manifest model, the `skills/` discovery,
 * and — crucially — the `mcpInputs` derivation are net-new; the awesome-copilot
 * helper folds **servers only** and has no concept of inputs.
 *
 * Verified against real source before writing (mandatory project rule):
 * - `validateAgentPluginManifest(obj, mode)` and `AgentPluginPackage` /
 *   `McpServerDef` / `McpInput` (`packages/core/src/domain/agent-plugin/*`).
 * - `extractPluginMcpServers(manifest): Record<string, unknown>` and
 *   `parsePluginManifest(raw): PluginManifest`
 *   (`packages/infra/src/harvest/plugin-manifest.ts`).
 * - The v1 `mcp.json` top-level key is `mcpServers` (a Record) +
 *   `inputs` (an array), per `AGENT_PLUGIN_MCP_SCHEMA`
 *   (`packages/core/src/public/schemas/agent-plugin-mcp.schema.json`). That
 *   key matches what `extractPluginMcpServers` reads (`mcpServers` /
 *   `mcp.items`), so the helper is reused directly for servers — no key-map
 *   is needed (the "silent-empty-fold" risk R3 warns about does not apply).
 * @module harvest/agent-plugin-manifest
 */

import {
  type AgentPluginPackage,
  type AgentPluginValidationMode,
  type McpInput,
  type McpServerDef,
  type PluginManifest,
  type SkillRef,
  validateAgentPluginManifest,
  type ValidationResult,
} from '@ai-primitives-hub/core';
import {
  extractPluginMcpServers,
  parsePluginManifest,
} from './plugin-manifest';

/**
 * The folded MCP declarations from a root `mcp.json`: servers as a
 * name→config `Record` (the shape the deployment-manifest's `mcpServers`
 * and `app`'s input-merge already consume) and inputs as a separate array.
 */
export interface FoldedMcp {
  /** Server configs keyed by server name. */
  servers: Record<string, unknown>;
  /** MCP input declarations (secrets / configurable values). */
  inputs: McpInput[];
}

/** Inputs passed to {@link buildAgentPluginPackage} by the adapters. */
export interface BuildAgentPluginPackageInput {
  /** The parsed (untrusted) root `plugin.json` object. */
  manifest: unknown;
  /** Skills discovered under `skills/` (adapter-supplied). */
  skills: SkillRef[];
  /** Folded MCP declarations, when a root `mcp.json` was present. */
  mcp?: FoldedMcp;
  /** `resilient` for consume (skip-invalid), `strict` for authoring (U4). */
  mode: AgentPluginValidationMode;
}

/** Outcome of building a package: the validation result plus, when the manifest is valid, the model. */
export interface BuildAgentPluginPackageResult {
  /** The U1 validation result (delegated — U2 does not re-implement schema/name rules). */
  validation: ValidationResult;
  /** The built package, or `null` when a fatal validation issue makes the plugin unusable. */
  package: AgentPluginPackage | null;
}

/**
 * Parse a root `plugin.json` string into a plain object.
 *
 * Reuses the parse-guard from `harvest/plugin-manifest.ts` (throws a
 * descriptive `Error` on invalid JSON or a non-object root) rather than
 * re-implementing `JSON.parse` handling. The returned value is the raw,
 * still-untrusted object — validation is a separate step
 * ({@link buildAgentPluginPackage} → U1 `validateAgentPluginManifest`).
 * @param raw - UTF-8 contents of the `plugin.json` file.
 * @returns The parsed object (permissive superset — missing fields are fine).
 * @throws {Error} If the input is not valid JSON or its root is not an object.
 */
export function parseAgentPluginManifest(raw: string): Record<string, unknown> {
  return parsePluginManifest(raw);
}

/**
 * Fold a root `mcp.json` into servers (via the reused, servers-only helper)
 * and inputs (derived separately here — the helper has no inputs concept).
 * @param rawMcpJson - UTF-8 contents of the root `mcp.json` file.
 * @returns The folded servers Record + inputs array.
 * @throws {Error} If the input is not valid JSON or its root is not an object.
 */
export function foldMcpJson(rawMcpJson: string): FoldedMcp {
  const parsed = parsePluginManifest(rawMcpJson);
  return {
    servers: extractPluginMcpServers(parsed),
    inputs: deriveMcpInputs(parsed)
  };
}

/**
 * Derive the `McpInput[]` list from a parsed `mcp.json`'s top-level `inputs`
 * array. Mirrors how the manifest builder reads `collection.mcp?.inputs` and
 * how `github-adapter` carries `manifest.mcpInputs` — a path the servers-only
 * `extractPluginMcpServers` does not cover. Non-object / id-less entries are
 * dropped (resilient consume).
 * @param parsed - A parsed `mcp.json` object.
 * @returns The input declarations, in declaration order.
 */
function deriveMcpInputs(parsed: PluginManifest): McpInput[] {
  const rawInputs = (parsed as { inputs?: unknown }).inputs;
  if (!Array.isArray(rawInputs)) {
    return [];
  }
  const inputs: McpInput[] = [];
  for (const entry of rawInputs) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.type !== 'string') {
      continue;
    }
    const input: McpInput = { id: record.id, type: record.type };
    if (typeof record.description === 'string') {
      input.description = record.description;
    }
    if (typeof record.password === 'boolean') {
      input.password = record.password;
    }
    if (typeof record.default === 'string') {
      input.default = record.default;
    }
    if (Array.isArray(record.options) && record.options.every((o) => typeof o === 'string')) {
      input.options = record.options;
    }
    inputs.push(input);
  }
  return inputs;
}

/**
 * Convert the helper's servers `Record` (name→config) into the U1 model's
 * `McpServerDef[]`. This is the reconciliation the U2 design flags: the
 * helper + on-disk manifest use a `Record`, but `AgentPluginPackage.mcpServers`
 * is typed `McpServerDef[]`. The round-trip is loss-free for the fields
 * `McpServerDef` models; {@link mcpServersRecordFromDefs} reverses it for
 * manifest synthesis.
 * @param servers - Server configs keyed by name.
 * @returns The array form used by the U1 model.
 */
export function mcpServerDefsFromRecord(servers: Record<string, unknown>): McpServerDef[] {
  return Object.entries(servers).map(([name, config]) => {
    const cfg = (config !== null && typeof config === 'object' && !Array.isArray(config))
      ? (config as Record<string, unknown>)
      : {};
    return { name, ...cfg };
  });
}

/**
 * Reverse of {@link mcpServerDefsFromRecord}: rebuild the name→config
 * `Record` the deployment-manifest's top-level `mcpServers` expects, from
 * the U1 model's `McpServerDef[]`.
 * @param defs - The model's server definitions.
 * @returns A name→config Record (the `name` field is lifted back to the key).
 */
export function mcpServersRecordFromDefs(defs: McpServerDef[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const { name, ...config } of defs) {
    record[name] = config;
  }
  return record;
}

/**
 * Build the U1 `AgentPluginPackage` from a parsed `plugin.json`, discovered
 * skills, and (optionally) folded MCP declarations.
 *
 * Validation is delegated to U1 `validateAgentPluginManifest` (R1 — U2 does
 * not re-implement schema/name rules). On a fatal issue (unparseable root,
 * missing/mistyped `$schema`/`name`) the plugin is unusable and `package` is
 * `null`; non-fatal issues in `resilient` mode are surfaced as warnings while
 * the package still builds (FR-5.2). The `extensions` slot is left empty —
 * agents/hooks under the reverse-domain namespace are populated by U7 (R4).
 * @param input - The manifest, discovered skills, folded MCP, and mode.
 * @returns The validation result and, when valid, the built package.
 */
export function buildAgentPluginPackage(input: BuildAgentPluginPackageInput): BuildAgentPluginPackageResult {
  const validation = validateAgentPluginManifest(input.manifest, input.mode);
  if (!validation.valid) {
    return { validation, package: null };
  }

  // Safe post-validation: a valid result guarantees `name` and `$schema` are strings.
  const record = input.manifest as Record<string, unknown>;
  const pkg: AgentPluginPackage = {
    name: record.name as string,
    $schema: record.$schema as string,
    skills: input.skills,
    mcpServers: input.mcp ? mcpServerDefsFromRecord(input.mcp.servers) : [],
    extensions: {}
  };
  if (input.mcp && input.mcp.inputs.length > 0) {
    pkg.mcpInputs = input.mcp.inputs;
  }
  return { validation, package: pkg };
}

/**
 * SEC-U2-2 (zip-slip, write side): is a relative archive-entry path safe to
 * add to a bundle ZIP? Rejects empty paths, absolute paths (POSIX `/…` and
 * Windows `C:\…`), and any path containing a `..` traversal segment.
 *
 * Net-new — neither skills adapter carries a traversal guard, so there is
 * nothing to inherit. Pure, so both adapters and the property tests share it.
 * @param relPath - The prospective ZIP entry path.
 * @returns `true` when the path is a safe relative entry, `false` otherwise.
 */
export function isSafeArchiveEntryPath(relPath: string): boolean {
  if (relPath.length === 0) {
    return false;
  }
  const normalized = relPath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  return !normalized.split('/').includes('..');
}

/**
 * Sanitize an untrusted plugin name into a bundle-id segment: lowercase,
 * keep only `[a-z0-9.-]`, collapse every other run to a single `-`, and trim
 * leading/trailing separators. Guarantees the result never carries a path
 * separator or a `..` traversal, so a synthesized bundle id is always a safe
 * single segment (ties into SEC-U2-2). Never empty (falls back to `plugin`).
 * @param name - The (untrusted) plugin name.
 * @returns A safe bundle-id segment.
 */
export function sanitizeBundleIdSegment(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9.-]+/gu, '-')
    .replaceAll(/^[.-]+|[.-]+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'plugin';
}
