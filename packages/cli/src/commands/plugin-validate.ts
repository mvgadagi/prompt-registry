/**
 * `plugin validate` subcommand.
 *
 * Strictly validates a local Agent Plugins directory (`plugin.json` and, when
 * present, the root `mcp.json`) against the vendored Agent Plugins v1 schemas
 * (FR-1.3, NFR-2). Wraps `validateAgentPluginDir` from `@ai-primitives-hub/app`
 * and routes the result through the framework's output formatter, mirroring
 * how `skill validate` delegates to `validateAllSkills`. Exits `0` when the
 * plugin is valid and non-zero on ANY issue (SEC-U4-1).
 * @module commands/plugin-validate
 */
import * as path from 'node:path';
import {
  type AgentPluginDirValidationResult,
  validateAgentPluginDir,
} from '@ai-primitives-hub/app';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
} from '../framework';

/**
 * Render plugin validation results as text.
 * @param d Validation result.
 * @returns Formatted text output.
 */
const renderText = (d: AgentPluginDirValidationResult): string => {
  const label = d.pluginName ?? '(unnamed)';
  const lines: string[] = [
    d.valid
      ? `[ OK ] plugin "${label}" is valid (${d.dir})`
      : `[FAIL] plugin "${label}" is invalid (${d.dir})`
  ];
  for (const e of d.errors) {
    lines.push(`  error: ${e}`);
  }
  for (const w of d.warnings) {
    lines.push(`  warning: ${w}`);
  }
  return `${lines.join('\n')}\n`;
};

/**
 * Plugin validate command class.
 */
export class PluginValidateCommand extends Command {
  public static readonly paths = [['plugin', 'validate']];

  public static readonly usage = Command.Usage({
    description: 'Validate a local Agent Plugins directory against the Agent Plugins v1 spec (strict).',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub plugin validate [dir] [options]

      Validates plugin.json (and, if present, mcp.json) against the vendored
      Agent Plugins v1.0.0 schemas in strict mode. Exits non-zero on any issue.

      Arguments:
        dir                         Plugin directory (default: current directory)

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)

      Examples:
        ai-primitives-hub plugin validate
        ai-primitives-hub plugin validate plugins/my-plugin
        ai-primitives-hub plugin validate plugins/my-plugin -o json
    `
  });

  public dir = Option.String({ required: false });
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public commandContext!: { ctx: Context };

  public execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';
    const rel = this.dir ?? '.';
    const dir = path.isAbsolute(rel) ? rel : path.join(ctx.cwd(), rel);
    const result = validateAgentPluginDir(dir);
    formatOutput({
      ctx,
      command: 'plugin.validate',
      output: fmt,
      status: result.valid ? 'ok' : 'error',
      data: result,
      warnings: result.warnings,
      textRenderer: renderText
    });
    return Promise.resolve(result.valid ? 0 : 1);
  }
}
