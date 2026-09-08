/**
 * Agent Plugins authoring use-cases: strict validation of a local plugin
 * directory (`plugin.json` + optional `mcp.json`) for the CLI (U4).
 * @module app/agent-plugin
 */
export {
  validateAgentPluginDir,
} from './validate-dir';
export type {
  AgentPluginDirValidationResult,
} from './validate-dir';
