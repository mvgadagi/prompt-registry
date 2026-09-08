/**
 * Agent Plugins directory validation use-case (file-IO dependent).
 * @module app/agent-plugin/validate-dir
 *
 * Orchestrates the strict validation of a local Agent Plugins directory for
 * the authoring CLI (U4). It reads `plugin.json` (required) and, when
 * present, the root `mcp.json`, then delegates the actual rule checks to the
 * pure `@ai-primitives-hub/core` validators (`validateAgentPluginManifest`
 * for `plugin.json`, `validateAgentPluginMcp` for `mcp.json`). Both are run
 * in `strict` mode: any issue makes the directory invalid (FR-1.3, NFR-2).
 *
 * This mirrors how `validateAllSkills` (this package's `collection/`) wraps
 * the pure skill validators — the app layer owns the disk read + result
 * aggregation, holds no schema rules of its own, and keeps the CLI command
 * thin (parse/format/exit only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  validateAgentPluginManifest,
  validateAgentPluginMcp,
} from '@ai-primitives-hub/core';

/**
 * Aggregated result of validating a local Agent Plugins directory.
 */
export interface AgentPluginDirValidationResult {
  /** The directory that was validated. */
  dir: string;
  /** The plugin `name` when `plugin.json` parsed to an object with a string name. */
  pluginName?: string;
  /** True when there were no errors across `plugin.json` and (optional) `mcp.json`. */
  valid: boolean;
  /** File-prefixed error messages (`plugin.json: ...`, `mcp.json: ...`). */
  errors: string[];
  /** File-prefixed non-fatal messages (empty in strict mode unless surfaced). */
  warnings: string[];
  /** Whether a root `mcp.json` was present and validated. */
  hasMcp: boolean;
}

/**
 * Read the `name` field from a parsed manifest, if it is a string.
 * @param manifest - The parsed `plugin.json` candidate.
 * @returns The plugin name, or `undefined` when absent/mistyped.
 */
function readPluginName(manifest: unknown): string | undefined {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return undefined;
  }
  const name = (manifest as Record<string, unknown>).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Strictly validate a local Agent Plugins directory.
 *
 * Never throws for expected authoring mistakes (missing/invalid files):
 * those are returned as errors so the command can exit non-zero cleanly.
 * @param dir - Absolute (or caller-resolved) path to the plugin directory.
 * @returns The aggregated validation result; `valid` is `false` on any issue.
 */
export function validateAgentPluginDir(dir: string): AgentPluginDirValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pluginJsonPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    return {
      dir,
      valid: false,
      errors: [`plugin.json: not found in ${dir}`],
      warnings,
      hasMcp: false
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  } catch (err) {
    return {
      dir,
      valid: false,
      errors: [`plugin.json: invalid JSON: ${(err as Error).message}`],
      warnings,
      hasMcp: false
    };
  }

  const manifestResult = validateAgentPluginManifest(manifest, 'strict');
  for (const e of manifestResult.errors) {
    errors.push(`plugin.json: ${e}`);
  }
  for (const w of manifestResult.warnings ?? []) {
    warnings.push(`plugin.json: ${w}`);
  }
  const pluginName = readPluginName(manifest);

  const mcpJsonPath = path.join(dir, 'mcp.json');
  const hasMcp = fs.existsSync(mcpJsonPath);
  if (hasMcp) {
    try {
      const mcp: unknown = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      const mcpResult = validateAgentPluginMcp(mcp, 'strict');
      for (const e of mcpResult.errors) {
        errors.push(`mcp.json: ${e}`);
      }
      for (const w of mcpResult.warnings ?? []) {
        warnings.push(`mcp.json: ${w}`);
      }
    } catch (err) {
      errors.push(`mcp.json: invalid JSON: ${(err as Error).message}`);
    }
  }

  return {
    dir,
    ...(pluginName === undefined ? {} : { pluginName }),
    valid: errors.length === 0,
    errors,
    warnings,
    hasMcp
  };
}
