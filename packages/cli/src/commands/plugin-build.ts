/**
 * `plugin build` subcommand.
 *
 * Packages a local Agent Plugins directory into a synthesized
 * `deployment-manifest.yml` plus a reproducible `<id>.bundle.zip`.
 *
 * Security gate (SEC-U4-1, NFR-2): the SAME strict validation `plugin validate`
 * runs is executed FIRST; on any issue the command aborts non-zero and emits
 * NO artifact.
 *
 * Entry-source decision (design open item — documented in code-summary.md):
 * a plugin directory has no collection file, so the collection-scripts
 * `createReleaseManifestPlan` (which requires a repoRoot + collectionFile +
 * git source tree) is NOT applicable — using it would be a false reuse. Bundle
 * entries are instead collected from a BOUNDED allow-list of the plugin
 * layout (`plugin.json`, optional `mcp.json`, and files under `skills/**`),
 * never an unfiltered directory sweep (SEC-U4-5). Every entry name is passed
 * through core `normalizeRepoRelativePath`, which throws on `..`/absolute
 * (SEC-U4-2), exactly as `bundle build` does. Symlink handling is at parity
 * with `bundle build` (no realpath guard; accepted risk, SEC-U4-3). No plugin
 * content is executed (SEC-U4-6).
 *
 * The synthesized manifest uses the LEGACY manifest shape (`id`/`version`/
 * `name`, no `formatVersion`): the governed `formatVersion: 1` contract
 * requires a full sha256 file inventory + git provenance + license evidence
 * that a local plugin directory does not carry, so it is re-verified against
 * `validateManifest`'s legacy id/version/name contract via the same
 * `ZipBundleExtractor` re-check `bundle build` performs.
 *
 * Reproducibility mirrors `bundle build`: fixed `1980-01-01` timestamps,
 * lexicographically sorted entries, and maximum zlib compression.
 * @module commands/plugin-build
 */
import {
  createWriteStream,
  existsSync,
  unlinkSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  validateAgentPluginDir,
} from '@ai-primitives-hub/app';
import {
  normalizeRepoRelativePath,
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import {
  generateBundleId,
  serializeReleaseManifest,
} from '@prompt-registry/collection-scripts';
import archiver from 'archiver';
import {
  Command,
  type Context,
  formatOutput,
  Option,
  type OutputFormat,
  RegistryError,
  renderError,
} from '../framework';

/** A raw bundle entry: plugin-relative path (POSIX) + verbatim bytes. */
export interface PluginBundleEntry {
  path: string;
  bytes: Uint8Array;
}

/** Plugin build result data. */
interface PluginBuildData {
  pluginId: string;
  version: string;
  outDir: string;
  manifestAsset: string;
  zipAsset: string;
  bundleId: string;
  entryCount: number;
}

/** Fixed date for reproducible bundle timestamps (mirrors `bundle build`). */
const FIXED_DATE = new Date('1980-01-01T00:00:00.000Z');

/** The only root files pulled into a plugin bundle (bounded entry set, SEC-U4-5). */
const ROOT_ALLOWLIST = ['plugin.json', 'mcp.json'] as const;

/** The only subtree walked for plugin content (bounded entry set, SEC-U4-5). */
const CONTENT_SUBTREE = 'skills';

/**
 * Recursively collect files under a directory as plugin-relative entries.
 * @param ctx CLI context (the single IO seam).
 * @param root Absolute plugin root directory.
 * @param relDir Directory to walk, relative to `root` (POSIX).
 * @param out Accumulator for discovered entries.
 */
const walkSubtree = async (
  ctx: Context,
  root: string,
  relDir: string,
  out: PluginBundleEntry[]
): Promise<void> => {
  const absDir = path.join(root, relDir);
  const entries = await ctx.fs.readDirEntries(absDir);
  for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)))) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory) {
      await walkSubtree(ctx, root, relPath, out);
    } else {
      out.push({ path: relPath, bytes: await ctx.fs.readFileBytes(path.join(root, relPath)) });
    }
  }
};

/**
 * Collect the bounded bundle entry set from a plugin directory.
 *
 * Only the manifest files (`plugin.json`, optional `mcp.json`) and the
 * `skills/**` content subtree are included — root-level secrets/config
 * (`.env`, VCS metadata, etc.) are deliberately excluded (SEC-U4-5).
 * @param ctx CLI context.
 * @param dir Absolute plugin directory.
 * @returns The raw entries (unsorted, unnormalized).
 */
export const collectPluginBundleEntries = async (
  ctx: Context,
  dir: string
): Promise<PluginBundleEntry[]> => {
  const entries: PluginBundleEntry[] = [];
  for (const name of ROOT_ALLOWLIST) {
    if (await ctx.fs.exists(path.join(dir, name))) {
      entries.push({ path: name, bytes: await ctx.fs.readFileBytes(path.join(dir, name)) });
    }
  }
  if (await ctx.fs.exists(path.join(dir, CONTENT_SUBTREE))) {
    await walkSubtree(ctx, dir, CONTENT_SUBTREE, entries);
  }
  return entries;
};

/**
 * Normalize + sort bundle entries, rejecting any path that escapes the
 * plugin root (`..` traversal or absolute) via core `normalizeRepoRelativePath`
 * (SEC-U4-2). Pure and synchronous so it is directly unit-testable.
 * @param entries Raw entries.
 * @returns Normalized entries in deterministic (lexicographic) order.
 * @throws {Error} When any entry path is not a safe repo-relative path.
 */
export const normalizePluginBundleEntries = (entries: PluginBundleEntry[]): PluginBundleEntry[] =>
  entries
    .map((entry) => ({ path: normalizeRepoRelativePath(entry.path), bytes: entry.bytes }))
    .toSorted((a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)));

/**
 * Create a deterministic ZIP archive with fixed timestamps and pre-sorted,
 * pre-normalized entries (mirrors `bundle build`'s `createDeterministicZip`).
 * @param input Zip creation parameters.
 * @param input.zipPath Destination path.
 * @param input.manifest Serialized `deployment-manifest.yml` contents.
 * @param input.entries Already normalized + sorted entries.
 * @returns Promise resolving once the ZIP is written.
 */
const createDeterministicZip = (input: {
  zipPath: string;
  manifest: string;
  entries: PluginBundleEntry[];
}): Promise<void> =>
  new Promise((resolve, reject) => {
    const output = createWriteStream(input.zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        output.destroy();
        if (existsSync(input.zipPath)) {
          unlinkSync(input.zipPath);
        }
      } catch {
        // Ignore cleanup errors.
      }
    };
    output.on('close', resolve);
    output.on('error', (err) => {
      cleanup();
      reject(err);
    });
    archive.on('error', (err) => {
      cleanup();
      reject(err);
    });
    archive.pipe(output);
    archive.append(input.manifest, { name: 'deployment-manifest.yml', date: FIXED_DATE });
    for (const entry of input.entries) {
      archive.append(Buffer.from(entry.bytes), { name: entry.path, date: FIXED_DATE });
    }
    archive.finalize().catch(() => { /* handled by archive.on('error') above */ });
  });

/**
 * Emit an error in the appropriate output format.
 * @param ctx CLI context.
 * @param output Output format.
 * @param err Registry error.
 */
const emitError = (ctx: Context, output: OutputFormat, err: RegistryError): void => {
  if (output === 'json' || output === 'yaml' || output === 'ndjson') {
    formatOutput({
      ctx,
      command: 'plugin.build',
      output,
      status: 'error',
      data: null,
      errors: [err.toJSON()]
    });
  } else {
    renderError(err, ctx);
  }
};

/**
 * Re-read the written ZIP and assert it satisfies the manifest contract,
 * exactly as `bundle build` does.
 * @param zipPath Path to the built ZIP.
 * @param pluginId Expected manifest id.
 * @param version Expected manifest version.
 */
const validateBuiltArchive = async (
  zipPath: string,
  pluginId: string,
  version: string
): Promise<void> => {
  const files = await new ZipBundleExtractor().extract(await fs.readFile(zipPath));
  validateManifest(files, { expectedId: pluginId, expectedVersion: version });
};

/**
 * Plugin build command class.
 */
export class PluginBuildCommand extends Command {
  public static readonly paths = [['plugin', 'build']];

  public static readonly usage = Command.Usage({
    description: 'Validate (strict) a local plugin directory and package it into a deterministic bundle.',
    category: 'Build & Author',
    details: `
      Usage: ai-primitives-hub plugin build [dir] [options]

      Strictly validates the plugin (plugin.json + optional mcp.json) and, only
      when valid, synthesizes deployment-manifest.yml plus <id>.bundle.zip from
      the plugin's manifest files and skills/. Emits no artifact on validation
      failure.

      Arguments:
        dir                         Plugin directory (default: current directory)

      Options:
        -o, --output <format>       Output format (text, json, yaml, ndjson)
        --version <version>         Bundle version (default: 0.0.0-dev)
        --out-dir <dir>             Output directory (default: dist)
        --repo-slug <slug>          Repo slug (owner-repo, or GITHUB_REPOSITORY env var, or cwd dirname)

      Examples:
        ai-primitives-hub plugin build plugins/my-plugin --version 1.0.0
        ai-primitives-hub plugin build plugins/my-plugin -o json
    `
  });

  public dir = Option.String({ required: false });
  public output = Option.String('-o', '--output') as OutputFormat | undefined;
  public version = Option.String('--version');
  public outDir = Option.String('--out-dir');
  public repoSlug = Option.String('--repo-slug');
  public commandContext!: { ctx: Context };

  public async execute(): Promise<number> {
    const { ctx } = this.commandContext;
    const fmt = this.output ?? 'text';
    const version = this.version ?? '0.0.0-dev';

    try {
      const cwd = ctx.cwd();
      const rel = this.dir ?? '.';
      const dir = path.isAbsolute(rel) ? rel : path.join(cwd, rel);

      // SEC-U4-1 / NFR-2: strict gate FIRST — abort with no artifact on any issue.
      const validation = validateAgentPluginDir(dir);
      if (!validation.valid) {
        throw new RegistryError({
          code: 'PLUGIN.VALIDATION_FAILED',
          message: `plugin validation failed; no bundle written:\n  ${validation.errors.join('\n  ')}`
        });
      }
      const pluginId = validation.pluginName;
      if (pluginId === undefined || pluginId.length === 0) {
        throw new RegistryError({
          code: 'PLUGIN.INVALID_MANIFEST',
          message: 'plugin.json name is required'
        });
      }

      const repoSlug = (this.repoSlug
        ?? (ctx.env.GITHUB_REPOSITORY ?? '').replaceAll('/', '-'))
      || path.basename(cwd);

      const outDirRel = this.outDir ?? 'dist';
      const outDir = path.isAbsolute(outDirRel) ? outDirRel : path.join(cwd, outDirRel);
      const pluginOutDir = path.join(outDir, pluginId);
      await ctx.fs.mkdir(pluginOutDir, { recursive: true });

      // Bounded entry set (SEC-U4-5) + path normalization (SEC-U4-2).
      const rawEntries = await collectPluginBundleEntries(ctx, dir);
      const entries = normalizePluginBundleEntries(rawEntries);

      // Legacy-shape manifest (no formatVersion): id/version/name only.
      const manifestYaml = serializeReleaseManifest({ id: pluginId, version, name: pluginId });
      const manifestPath = path.join(pluginOutDir, 'deployment-manifest.yml');
      await ctx.fs.writeFile(manifestPath, manifestYaml);

      const zipPath = path.join(pluginOutDir, `${pluginId}.bundle.zip`);
      await createDeterministicZip({ zipPath, manifest: manifestYaml, entries });
      await validateBuiltArchive(zipPath, pluginId, version);

      const bundleId = generateBundleId(repoSlug, pluginId, version);
      const data: PluginBuildData = {
        pluginId,
        version,
        outDir: pluginOutDir.replaceAll('\\', '/'),
        manifestAsset: manifestPath.replaceAll('\\', '/'),
        zipAsset: zipPath.replaceAll('\\', '/'),
        bundleId,
        entryCount: entries.length
      };
      formatOutput({
        ctx,
        command: 'plugin.build',
        output: fmt,
        status: 'ok',
        data,
        textRenderer: (d) =>
          `Built ${d.zipAsset} (bundle id: ${d.bundleId}, version: ${d.version}, ${d.entryCount} entr${d.entryCount === 1 ? 'y' : 'ies'})\n`
      });
      return 0;
    } catch (err) {
      const re = err instanceof RegistryError
        ? err
        : new RegistryError({
          code: 'INTERNAL.UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
          cause: err
        });
      emitError(ctx, fmt, re);
      return 1;
    }
  }
}
