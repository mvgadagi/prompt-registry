/**
 * Domain layer — Agent Plugins model types.
 *
 * The parsed, validated representation of an Agent Plugins v1.0.0 package
 * (`plugin.json` + discovered components), per the U1 functional design
 * (`domain-entities.md`). Pure data only (C-1): no I/O, no framework
 * imports. The collections (`skills`, `mcpServers`) and the `extensions`
 * map are populated by later units (U2 parser, U7 namespace); U1 owns the
 * type shape and the namespace constant.
 *
 * Reuse note: core has no pre-existing `SkillRef` / `McpServerDef` /
 * `McpInput` types (searched: `domain/skill/validate.ts` exposes
 * `SkillMetadata`; `domain/mcp/inputs.ts` exposes `McpInputDeclaration` /
 * `McpServerInputView`). Minimal local types are defined here to model the
 * `AgentPluginPackage` shape and are intentionally lean — richer per-IDE
 * shapes live in the delivery/infra layers.
 * @module domain/agent-plugin/types
 */

/**
 * The reverse-domain extension namespace this hub owns.
 *
 * Agents and hooks are NOT Agent Plugins v1 portable component kinds; they
 * are carried under this reverse-domain top-level namespace
 * (`com.amadeus.aiprimitiveshub/{agents,hooks}/`) so a conformant
 * third-party client ignores them (Agent Plugins §8.2 / §11.3). U1 defines
 * the constant and the `extensions` slot; U7 populates it.
 */
export const AGENT_PLUGINS_EXTENSION_NS = 'com.amadeus.aiprimitiveshub';

/**
 * A reference to a skill carried by the package (discovered under `skills/`).
 * Minimal local type — populated by the parser (U2).
 */
export interface SkillRef {
  /** Skill name (as declared in the skill's `SKILL.md` frontmatter). */
  name: string;
  /** Path to the skill, relative to the package root. */
  path?: string;
}

/**
 * A single MCP server definition (from the package's root `mcp.json`).
 * Minimal local type — populated by the parser (U2). Richer, per-host server
 * shapes live in the delivery layer.
 */
export interface McpServerDef {
  /** Server name as declared in `mcp.json`. */
  name: string;
  /** Transport type. */
  type?: 'stdio' | 'http' | 'sse';
  /** Command to launch a stdio server. */
  command?: string;
  /** Arguments for a stdio server command. */
  args?: string[];
  /** Environment variables for a stdio server. */
  env?: Record<string, string>;
  /** URL for a remote (http/sse) server. */
  url?: string;
  /** Request headers for a remote server. */
  headers?: Record<string, string>;
}

/**
 * An MCP input declaration referenced via `${input:id}` placeholders.
 * Minimal local type — the full per-IDE input definition lives in the
 * delivery layer (see `domain/mcp/inputs.ts` `McpInputDeclaration`).
 */
export interface McpInput {
  /** Unique identifier referenced by `${input:<id>}`. */
  id: string;
  /** Discriminator for the prompt type. */
  type: string;
  /** Human-readable description shown in the prompt. */
  description?: string;
  /** Whether the value is masked (secrets). */
  password?: boolean;
  /** Default value pre-filled in the prompt. */
  default?: string;
  /** Options for a pick-style input. */
  options?: string[];
}

/**
 * The parsed, validated representation of an Agent Plugins v1 package.
 *
 * A candidate object is only promoted to `AgentPluginPackage` after
 * {@link validateAgentPluginManifest} succeeds for the active mode
 * (strict for authoring, resilient for consume).
 */
export interface AgentPluginPackage {
  /** Package name; obeys the R1 name grammar. */
  name: string;
  /** Required; identifies the v1 schema this package conforms to. */
  $schema: string;
  /** Skills discovered under `skills/` (populated by U2). */
  skills: SkillRef[];
  /** MCP servers from the root `mcp.json` (populated by U2). */
  mcpServers: McpServerDef[];
  /** Optional MCP input declarations. */
  mcpInputs?: McpInput[];
  /**
   * Client-owned extensions, keyed by reverse-domain namespace. Agents and
   * hooks live under {@link AGENT_PLUGINS_EXTENSION_NS} (populated by U7).
   */
  extensions: Record<string, unknown>;
}
