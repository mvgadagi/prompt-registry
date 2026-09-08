/**
 * Local Agent Plugins source adapter — the local twin of
 * {@link AgentPluginsSourceAdapter}. Discovers an Agent Plugins v1 package
 * (root `plugin.json`, `skills/<id>/SKILL.md`, optional root `mcp.json`)
 * from a local directory instead of a GitHub repository, for authoring and
 * testing before publishing.
 *
 * Mirrors `LocalSkillsAdapter`: the same `(source, fs, clock)` constructor,
 * normal disk reads through the injected `FileSystem` port, and the same
 * "bake a synthesized `deployment-manifest.yml` + skill files into a ZIP"
 * synthesis. Parsing/validation and MCP folding are delegated to the pure
 * `harvest/agent-plugin-manifest.ts` parser (which delegates schema/name
 * rules to U1).
 *
 * Security controls (U2 `nfr-design/security-design.md`):
 * - SEC-U2-1: `plugin.json` validated via U1 `validateAgentPluginManifest`
 *   (`resilient`) on consume.
 * - SEC-U2-2: every ZIP entry path is checked with `isSafeArchiveEntryPath`.
 * - SEC-U2-7 (local symlink escape): the injected `FileSystem` port exposes
 *   no `realpath`/`lstat`/symlink primitive, so `assertWithinRoot` uses
 *   `node:fs` `realpathSync`/`lstatSync` DIRECTLY to resolve each skill file
 *   and reject any path that escapes the plugin root. This is the documented,
 *   scoped deviation from the injected-fs pattern (blast radius: this one
 *   guard method); it is exercised by a real temp-dir fixture test, not the
 *   in-memory double (which has no symlink concept).
 * - SEC-U2-6: archive DoS accepted at parity with `LocalSkillsAdapter`.
 * @module adapters/local-agent-plugins-adapter
 */
import * as crypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type {
  Bundle,
  Clock,
  FileSystem,
  RegistrySource,
  SkillRef,
  SourceMetadata,
  ValidationResult,
} from '@ai-primitives-hub/core';
import archiver from 'archiver';
import * as yaml from 'js-yaml';
import {
  buildAgentPluginPackage,
  type FoldedMcp,
  foldMcpJson,
  isSafeArchiveEntryPath,
  parseAgentPluginManifest,
  sanitizeBundleIdSegment,
} from '../harvest/agent-plugin-manifest';
import {
  BaseSourceAdapter,
} from './base-source-adapter';
import {
  isValidLocalUrl,
  resolveLocalPath,
  toFileUrl,
} from './local-path';

const PLUGIN_ENVIRONMENTS = ['claude', 'vscode', 'claude-code'];
const PLUGIN_TAGS = ['agent-plugin', 'skill', 'local'];
const ESTIMATED_BYTES_PER_FILE = 4096;

interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
}

interface SkillItem {
  id: string;
  name: string;
  description: string;
  license?: string;
  path: string;
  files: string[];
}

interface DiscoveredPlugin {
  name: string;
  description: string;
  license?: string;
  skills: SkillItem[];
  mcp?: FoldedMcp;
  contentHash: string;
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(raw);
  if (!match) {
    return {};
  }
  try {
    return (yaml.load(match[1]) as SkillFrontmatter | undefined) ?? {};
  } catch {
    return {};
  }
}

function estimatePluginSize(fileCount: number): string {
  const estimatedBytes = fileCount * ESTIMATED_BYTES_PER_FILE;
  if (estimatedBytes < 1024) {
    return `${estimatedBytes} B`;
  }
  if (estimatedBytes < 1024 * 1024) {
    return `${(estimatedBytes / 1024).toFixed(1)} KB`;
  }
  return `${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class LocalAgentPluginsAdapter extends BaseSourceAdapter {
  public readonly type = 'local-agent-plugins';

  public constructor(
    source: RegistrySource,
    private readonly fs: FileSystem,
    private readonly clock: Clock
  ) {
    super(source);
    if (!isValidLocalUrl(source.url)) {
      throw new Error(`Invalid local agent-plugins path: ${source.url}`);
    }
  }

  private getLocalPath(): string {
    return resolveLocalPath(this.source.url);
  }

  private getSourceName(): string {
    return path.basename(this.getLocalPath());
  }

  private buildBundleId(pluginName: string): string {
    return `local-agent-plugins-${this.getSourceName()}-${sanitizeBundleIdSegment(pluginName)}`;
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    if (!(await this.fs.exists(dirPath))) {
      return false;
    }
    return (await this.fs.stat(dirPath)).isDirectory;
  }

  /**
   * SEC-U2-7: resolve `absPath` with `node:fs` and reject it if the real,
   * symlink-followed path escapes the plugin root. Uses `node:fs` directly
   * because the injected `FileSystem` port models no symlink resolution.
   * @param absPath - The absolute on-disk path about to be read.
   * @throws {Error} When the path resolves outside the plugin root.
   */
  private assertWithinRoot(absPath: string): void {
    const rootReal = nodeFs.realpathSync(this.getLocalPath());
    let real: string;
    try {
      real = nodeFs.realpathSync(absPath);
    } catch {
      throw new Error(`Refusing to read unresolvable path (possible broken symlink): ${absPath}`);
    }
    const rel = path.relative(rootReal, real);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`Refusing to read path escaping the plugin root (SEC-U2-7): ${absPath}`);
    }
  }

  private async readManifest(): Promise<Record<string, unknown>> {
    return parseAgentPluginManifest(await this.fs.readFile(path.join(this.getLocalPath(), 'plugin.json')));
  }

  private async readMcp(): Promise<FoldedMcp | undefined> {
    const mcpPath = path.join(this.getLocalPath(), 'mcp.json');
    if (!(await this.fs.exists(mcpPath))) {
      return undefined;
    }
    try {
      return foldMcpJson(await this.fs.readFile(mcpPath));
    } catch {
      return undefined;
    }
  }

  private async listSkillFiles(skillPath: string, relativePrefix = ''): Promise<string[]> {
    const entries = await this.fs.readDirEntries(skillPath);
    const results: string[] = [];
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        results.push(...(await this.listSkillFiles(path.join(skillPath, entry.name), relativePath)));
      } else {
        results.push(relativePath);
      }
    }
    return results;
  }

  private async processSkillDirectory(skillId: string, skillsDir: string): Promise<SkillItem | undefined> {
    const skillPath = path.join(skillsDir, skillId);
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!(await this.fs.exists(skillMdPath))) {
      return undefined;
    }
    try {
      const frontmatter = parseFrontmatter(await this.fs.readFile(skillMdPath));
      const files = await this.listSkillFiles(skillPath);
      return {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || 'No description',
        license: frontmatter.license,
        path: `skills/${skillId}`,
        files
      };
    } catch {
      return undefined;
    }
  }

  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    const skillsDir = path.join(this.getLocalPath(), 'skills');
    let entries;
    try {
      entries = await this.fs.readDirEntries(skillsDir);
    } catch (error) {
      throw new Error(`Failed to scan skills directory: ${error instanceof Error ? error.message : error}`);
    }
    const skills: SkillItem[] = [];
    for (const entry of entries.filter((item) => item.isDirectory)) {
      const skill = await this.processSkillDirectory(entry.name, skillsDir);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  private async calculateContentHash(skills: SkillItem[]): Promise<string> {
    const hash = crypto.createHash('sha256');
    const pairs: { key: string; absPath: string }[] = [];
    for (const skill of skills) {
      const skillDir = path.join(this.getLocalPath(), skill.path);
      for (const file of skill.files) {
        pairs.push({ key: `${skill.path}/${file}`, absPath: path.join(skillDir, file) });
      }
    }
    for (const pair of pairs.toSorted((a, b) => a.key.localeCompare(b.key))) {
      const content = await this.fs.readFile(pair.absPath);
      hash.update(pair.key).update(':').update(content).update('|');
    }
    return hash.digest('hex');
  }

  private async discoverPlugin(): Promise<DiscoveredPlugin | undefined> {
    const manifest = await this.readManifest();
    const skills = await this.scanSkillsDirectory();
    const mcp = await this.readMcp();

    const skillRefs: SkillRef[] = skills.map((skill) => ({ name: skill.name, path: skill.path }));
    const { package: pkg } = buildAgentPluginPackage({ manifest, skills: skillRefs, mcp, mode: 'resilient' });
    if (!pkg) {
      return undefined;
    }

    const description = typeof manifest.description === 'string' ? manifest.description : 'Agent Plugins package';
    const license = typeof manifest.license === 'string' ? manifest.license : undefined;
    return {
      name: pkg.name,
      description,
      license,
      skills,
      mcp,
      contentHash: await this.calculateContentHash(skills)
    };
  }

  private createBundleFromPlugin(plugin: DiscoveredPlugin): Bundle {
    const bundleId = this.buildBundleId(plugin.name);
    return {
      id: bundleId,
      name: plugin.name,
      version: `hash:${plugin.contentHash}`,
      description: plugin.description,
      author: 'Local',
      sourceId: this.source.id,
      environments: PLUGIN_ENVIRONMENTS,
      tags: PLUGIN_TAGS,
      lastUpdated: this.clock.nowIso(),
      size: estimatePluginSize(plugin.skills.reduce((total, skill) => total + skill.files.length, 0)),
      dependencies: [],
      license: plugin.license || 'Unknown',
      repository: this.source.url,
      homepage: this.source.url,
      manifestUrl: this.getManifestUrl(),
      downloadUrl: this.getDownloadUrl()
    };
  }

  private createDeploymentManifest(plugin: DiscoveredPlugin): Record<string, unknown> {
    const manifest: Record<string, unknown> = {
      id: this.buildBundleId(plugin.name),
      version: `hash:${plugin.contentHash}`,
      name: plugin.name,
      metadata: {
        manifest_version: '1.0',
        description: plugin.description,
        author: 'Local',
        last_updated: this.clock.nowIso(),
        repository: {
          type: 'local',
          url: this.source.url,
          directory: '.'
        },
        license: plugin.license || 'Unknown',
        keywords: PLUGIN_TAGS
      },
      common: {
        directories: plugin.skills.map((skill) => `skills/${skill.id}`),
        files: [],
        include_patterns: ['**/*'],
        exclude_patterns: []
      },
      bundle_settings: {
        include_common_in_environment_bundles: true,
        create_common_bundle: true,
        compression: 'zip',
        naming: {
          common_bundle: sanitizeBundleIdSegment(plugin.name)
        }
      },
      prompts: plugin.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        file: `skills/${skill.id}/SKILL.md`,
        type: 'skill',
        tags: PLUGIN_TAGS
      }))
    };
    if (plugin.mcp && Object.keys(plugin.mcp.servers).length > 0) {
      manifest.mcpServers = plugin.mcp.servers;
    }
    if (plugin.mcp && plugin.mcp.inputs.length > 0) {
      manifest.mcpInputs = plugin.mcp.inputs;
    }
    return manifest;
  }

  private async createBundleArchive(plugin: DiscoveredPlugin): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    archive.append(yaml.dump(this.createDeploymentManifest(plugin)), { name: 'deployment-manifest.yml' });

    for (const skill of plugin.skills) {
      const skillDir = path.join(this.getLocalPath(), skill.path);
      for (const relativePath of skill.files) {
        const zipPath = `skills/${skill.id}/${relativePath}`;
        if (!isSafeArchiveEntryPath(zipPath)) {
          throw new Error(`Unsafe archive entry path rejected (SEC-U2-2): ${zipPath}`);
        }
        const absPath = path.join(skillDir, relativePath);
        this.assertWithinRoot(absPath); // SEC-U2-7
        archive.append(await this.fs.readFile(absPath), { name: zipPath });
      }
    }

    await archive.finalize();
    return finished;
  }

  public requiresAuthentication(): boolean {
    return false;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    let plugin: DiscoveredPlugin | undefined;
    try {
      plugin = await this.discoverPlugin();
    } catch (error) {
      throw new Error(`Failed to fetch local agent plugin: ${error instanceof Error ? error.message : error}`);
    }
    return plugin ? [this.createBundleFromPlugin(plugin)] : [];
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    try {
      const plugin = await this.discoverPlugin();
      if (!plugin || this.buildBundleId(plugin.name) !== bundle.id) {
        throw new Error(`Plugin not found for bundle: ${bundle.id}`);
      }
      return await this.createBundleArchive(plugin);
    } catch (error) {
      throw new Error(`Failed to download local agent plugin ${bundle.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const localPath = this.getLocalPath();
      const plugin = await this.discoverPlugin();
      const stats = await this.fs.stat(localPath);
      return {
        name: path.basename(localPath),
        description: 'Local Agent Plugins Repository',
        bundleCount: plugin ? 1 : 0,
        lastUpdated: new Date(stats.mtimeMs).toISOString(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch local agent plugin metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public getManifestUrl(): string {
    return toFileUrl(path.join(this.getLocalPath(), 'plugin.json'));
  }

  public getDownloadUrl(): string {
    return toFileUrl(this.getLocalPath());
  }

  public async validate(): Promise<ValidationResult> {
    const localPath = this.getLocalPath();
    if (!(await this.directoryExists(localPath))) {
      return { valid: false, errors: [`Directory does not exist: ${localPath}`], warnings: [], bundlesFound: 0 };
    }

    const manifestPath = path.join(localPath, 'plugin.json');
    if (!(await this.fs.exists(manifestPath))) {
      return { valid: false, errors: [`Missing required 'plugin.json': ${manifestPath}`], warnings: [], bundlesFound: 0 };
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = await this.readManifest();
    } catch (error) {
      return { valid: false, errors: [`Failed to read plugin.json: ${error instanceof Error ? error.message : error}`], warnings: [], bundlesFound: 0 };
    }

    const skills = (await this.directoryExists(path.join(localPath, 'skills'))) ? await this.scanSkillsDirectory() : [];
    const mcp = await this.readMcp();
    const skillRefs: SkillRef[] = skills.map((skill) => ({ name: skill.name, path: skill.path }));
    const { validation, package: pkg } = buildAgentPluginPackage({ manifest, skills: skillRefs, mcp, mode: 'resilient' });
    return {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings ?? [],
      bundlesFound: pkg ? 1 : 0
    };
  }
}
