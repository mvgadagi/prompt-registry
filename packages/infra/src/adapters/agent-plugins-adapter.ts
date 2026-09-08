/**
 * Agent Plugins source adapter (remote) — discovers an Agent Plugins v1
 * package (a root `plugin.json`, a `skills/` folder of Anthropic-style
 * skills, and an optional root `mcp.json`) in a GitHub repository and
 * surfaces it as an installable {@link Bundle}.
 *
 * Models `SkillsAdapter` (U2 functional design Q1=A / Q2=A): the same
 * `(source, githubApi, clock)` constructor, the same Git-Trees-API skills
 * discovery, and the same "bake a synthesized `deployment-manifest.yml` +
 * the skill files into a ZIP that `downloadBundle` returns" pattern, so the
 * unchanged install pipeline (`install/pipeline.ts`, `layout-resolver.ts`)
 * routes it with no change (FR-5.1). The plugin's parsing/validation and MCP
 * folding are delegated to the pure `harvest/agent-plugin-manifest.ts`
 * parser (which in turn delegates schema/name validation to U1).
 *
 * A repository holds a single root plugin, so `fetchBundles()` returns at
 * most one bundle (the plugin). MCP servers/inputs from the root `mcp.json`
 * are folded into the synthesized manifest's top-level `mcpServers` (Record)
 * / `mcpInputs` (array) — shapes the existing pipeline already consumes.
 *
 * Security controls (U2 `nfr-design/security-design.md`):
 * - SEC-U2-1: validate untrusted `plugin.json` via U1 `validateAgentPluginManifest`
 *   in `resilient` mode on the consume path.
 * - SEC-U2-2: every ZIP entry path is checked with `isSafeArchiveEntryPath`
 *   before it is appended (reject `..`/absolute).
 * - SEC-U2-6: archive DoS is accepted at parity with `SkillsAdapter` (same
 *   `archiver` + `Buffer.concat` accumulation; no new cap claimed).
 * @module adapters/agent-plugins-adapter
 */
import * as crypto from 'node:crypto';
import type {
  Bundle,
  Clock,
  GitHubApi,
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

const DEFAULT_BRANCH = 'main';
const PLUGIN_ENVIRONMENTS = ['claude', 'vscode', 'claude-code'];
const PLUGIN_TAGS = ['agent-plugin', 'skill'];
/** Crude per-file size heuristic, matching `SkillsAdapter` (no per-file byte size from the tree listing). */
const ESTIMATED_BYTES_PER_FILE = 4096;

type ArchiverInstance = ReturnType<typeof archiver>;

interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
}

interface GitHubContentItem {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // eslint-disable-next-line @typescript-eslint/naming-convention -- matches external API response shape
  download_url?: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
}

/** Internal per-skill enumeration record (mirrors `SkillsAdapter`'s `SkillItem`). */
interface SkillItem {
  id: string;
  name: string;
  description: string;
  license?: string;
  path: string;
  files: GitTreeEntry[];
}

/** The fully-discovered remote plugin: its validated identity + skills + folded MCP. */
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

/**
 * Stable hash over sorted (path, sha) pairs across every discovered file.
 * @param entries
 */
function calculateContentHash(entries: { path: string; sha?: string }[]): string {
  const hash = crypto.createHash('sha256');
  for (const entry of entries.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path).update(':').update(entry.sha ?? '').update('|');
  }
  return hash.digest('hex');
}

export class AgentPluginsSourceAdapter extends BaseSourceAdapter {
  public readonly type = 'agent-plugins';

  private readonly branch: string;

  public constructor(
    source: RegistrySource,
    private readonly githubApi: GitHubApi,
    private readonly clock: Clock
  ) {
    super(source);
    if (!AgentPluginsSourceAdapter.isValidGitHubUrl(source.url)) {
      throw new Error(`Invalid GitHub URL for agent-plugins source: ${source.url}`);
    }
    this.branch = source.config?.branch ?? DEFAULT_BRANCH;
  }

  private static isValidGitHubUrl(url: string): boolean {
    if (url.startsWith('https://')) {
      return url.includes('github.com');
    }
    if (url.startsWith('git@')) {
      return url.includes('github.com:');
    }
    return false;
  }

  private parseGitHubUrl(): { owner: string; repo: string } {
    const url = this.source.url.replace(/\.git$/, '');
    const match = /github\.com[/:]([^/]+)\/([^/]+)/.exec(url);
    if (!match) {
      throw new Error(`Invalid GitHub URL format: ${this.source.url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  private buildBundleId(owner: string, repo: string, pluginName: string): string {
    return `agent-plugins-${owner}-${repo}-${sanitizeBundleIdSegment(pluginName)}`;
  }

  private rawUrl(filePath: string): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://raw.githubusercontent.com/${owner}/${repo}/${this.branch}/${filePath}`;
  }

  /** Read the root `plugin.json` (throws on a missing/invalid file — fatal for the source). */
  private async readManifest(): Promise<Record<string, unknown>> {
    return parseAgentPluginManifest(await this.githubApi.getText(this.rawUrl('plugin.json')));
  }

  /** Read + fold the optional root `mcp.json`; absent/invalid → no MCP (not an error). */
  private async readMcp(): Promise<FoldedMcp | undefined> {
    try {
      return foldMcpJson(await this.githubApi.getText(this.rawUrl('mcp.json')));
    } catch {
      return undefined;
    }
  }

  /** Group the recursive tree by top-level `skills/<id>/` folder, requiring a `skills/<id>/SKILL.md`. */
  private async scanSkillsDirectory(): Promise<SkillItem[]> {
    const { owner, repo } = this.parseGitHubUrl();
    const tree = await this.githubApi.getJson<{ tree?: GitTreeEntry[] }>(
      `/repos/${owner}/${repo}/git/trees/${this.branch}?recursive=1`
    );

    const filesBySkill = new Map<string, GitTreeEntry[]>();
    const skillIds = new Set<string>();
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob') {
        continue;
      }
      const segments = entry.path.split('/');
      if (segments[0] !== 'skills' || segments.length < 3) {
        continue;
      }
      const files = filesBySkill.get(segments[1]) ?? [];
      files.push(entry);
      filesBySkill.set(segments[1], files);
      if (segments.length === 3 && segments[2] === 'SKILL.md') {
        skillIds.add(segments[1]);
      }
    }

    const skills: SkillItem[] = [];
    for (const skillId of skillIds) {
      const skill = await this.buildSkillFromTree(skillId, filesBySkill.get(skillId) ?? []);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  private async buildSkillFromTree(skillId: string, entries: GitTreeEntry[]): Promise<SkillItem | undefined> {
    const skillPath = `skills/${skillId}`;
    try {
      const frontmatter = parseFrontmatter(await this.githubApi.getText(this.rawUrl(`${skillPath}/SKILL.md`)));
      return {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || 'No description',
        license: frontmatter.license,
        path: skillPath,
        files: entries
      };
    } catch {
      return undefined;
    }
  }

  /** Discover + validate the whole plugin. Returns `undefined` when validation is fatally invalid (resilient consume). */
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
    const hashEntries = skills.flatMap((skill) => skill.files);
    return {
      name: pkg.name,
      description,
      license,
      skills,
      mcp,
      contentHash: calculateContentHash(hashEntries)
    };
  }

  private createBundleFromPlugin(plugin: DiscoveredPlugin, owner: string, repo: string): Bundle {
    const bundleId = this.buildBundleId(owner, repo, plugin.name);
    return {
      id: bundleId,
      name: plugin.name,
      version: `hash:${plugin.contentHash}`,
      description: plugin.description,
      author: owner,
      sourceId: this.source.id,
      environments: PLUGIN_ENVIRONMENTS,
      tags: PLUGIN_TAGS,
      lastUpdated: this.clock.nowIso(),
      size: estimatePluginSize(plugin.skills.reduce((total, skill) => total + skill.files.length, 0)),
      dependencies: [],
      license: plugin.license || 'Unknown',
      repository: this.source.url,
      homepage: `https://github.com/${owner}/${repo}/tree/${this.branch}`,
      manifestUrl: this.getManifestUrl(),
      downloadUrl: this.getDownloadUrl()
    };
  }

  private createDeploymentManifest(plugin: DiscoveredPlugin, owner: string, repo: string): Record<string, unknown> {
    const manifest: Record<string, unknown> = {
      id: this.buildBundleId(owner, repo, plugin.name),
      version: `hash:${plugin.contentHash}`,
      name: plugin.name,
      metadata: {
        manifest_version: '1.0',
        description: plugin.description,
        author: owner,
        last_updated: this.clock.nowIso(),
        repository: {
          type: 'git',
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
      // Servers flow as a name→config Record end-to-end (helper output → manifest);
      // the U1 model's McpServerDef[] reconciliation lives in the parser, not here.
      manifest.mcpServers = plugin.mcp.servers;
    }
    if (plugin.mcp && plugin.mcp.inputs.length > 0) {
      manifest.mcpInputs = plugin.mcp.inputs;
    }
    return manifest;
  }

  private async addDirectoryToArchive(archive: ArchiverInstance, owner: string, repo: string, dirPath: string, zipPath: string): Promise<void> {
    let dirContents: GitHubContentItem[];
    try {
      dirContents = await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${dirPath}`);
    } catch {
      return;
    }
    for (const item of dirContents) {
      const entryZipPath = `${zipPath}/${item.name}`;
      if (item.type === 'file' && item.download_url) {
        this.appendGuarded(archive, Buffer.from(await this.githubApi.download(item.download_url)), entryZipPath);
      } else if (item.type === 'dir') {
        await this.addDirectoryToArchive(archive, owner, repo, item.path, entryZipPath);
      }
    }
  }

  /**
   * SEC-U2-2: append only when the ZIP entry path is a safe relative path.
   * @param archive
   * @param content
   * @param zipPath
   */
  private appendGuarded(archive: ArchiverInstance, content: Buffer, zipPath: string): void {
    if (!isSafeArchiveEntryPath(zipPath)) {
      throw new Error(`Unsafe archive entry path rejected: ${zipPath}`);
    }
    archive.append(content, { name: zipPath });
  }

  private async createBundleArchive(plugin: DiscoveredPlugin, owner: string, repo: string): Promise<Buffer> {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', (err: Error) => reject(new Error(`Failed to create ZIP archive: ${err.message}`)));
    });

    archive.append(yaml.dump(this.createDeploymentManifest(plugin, owner, repo)), { name: 'deployment-manifest.yml' });

    for (const skill of plugin.skills) {
      const skillContents = await this.githubApi.getJson<GitHubContentItem[]>(`/repos/${owner}/${repo}/contents/${skill.path}`);
      for (const item of skillContents) {
        const entryZipPath = `skills/${skill.id}/${item.name}`;
        if (item.type === 'file' && item.download_url) {
          this.appendGuarded(archive, Buffer.from(await this.githubApi.download(item.download_url)), entryZipPath);
        } else if (item.type === 'dir') {
          await this.addDirectoryToArchive(archive, owner, repo, item.path, entryZipPath);
        }
      }
    }

    await archive.finalize();
    return finished;
  }

  public async fetchBundles(): Promise<Bundle[]> {
    const { owner, repo } = this.parseGitHubUrl();
    let plugin: DiscoveredPlugin | undefined;
    try {
      plugin = await this.discoverPlugin();
    } catch (error) {
      throw new Error(`Failed to fetch agent plugin: ${error instanceof Error ? error.message : error}`);
    }
    return plugin ? [this.createBundleFromPlugin(plugin, owner, repo)] : [];
  }

  public async downloadBundle(bundle: Bundle): Promise<Buffer> {
    const { owner, repo } = this.parseGitHubUrl();
    try {
      const plugin = await this.discoverPlugin();
      if (!plugin || this.buildBundleId(owner, repo, plugin.name) !== bundle.id) {
        throw new Error(`Plugin not found for bundle: ${bundle.id}`);
      }
      return await this.createBundleArchive(plugin, owner, repo);
    } catch (error) {
      throw new Error(`Failed to download agent plugin ${bundle.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  public async fetchMetadata(): Promise<SourceMetadata> {
    try {
      const { owner, repo } = this.parseGitHubUrl();
      const plugin = await this.discoverPlugin();
      return {
        name: `${owner}/${repo}`,
        description: 'Agent Plugins Repository',
        bundleCount: plugin ? 1 : 0,
        lastUpdated: this.clock.nowIso(),
        version: '1.0.0'
      };
    } catch (error) {
      throw new Error(`Failed to fetch agent plugin repository metadata: ${error instanceof Error ? error.message : error}`);
    }
  }

  public getManifestUrl(): string {
    return this.rawUrl('plugin.json');
  }

  public getDownloadUrl(): string {
    const { owner, repo } = this.parseGitHubUrl();
    return `https://github.com/${owner}/${repo}/archive/refs/heads/${this.branch}.zip`;
  }

  public async validate(): Promise<ValidationResult> {
    const { owner, repo } = this.parseGitHubUrl();
    try {
      await this.githubApi.getJson(`/repos/${owner}/${repo}`);
    } catch (error) {
      return {
        valid: false,
        errors: [`Agent plugins repository validation failed: ${error instanceof Error ? error.message : error}`],
        warnings: [],
        bundlesFound: 0
      };
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = await this.readManifest();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        errors: [message.includes('404') ? `Missing required 'plugin.json' at repository root` : `Failed to read plugin.json: ${message}`],
        warnings: [],
        bundlesFound: 0
      };
    }

    const skills = await this.scanSkillsDirectory();
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
