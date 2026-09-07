import {
  AGENT_PLUGINS_EXTENSION_NS,
  type Bundle,
  type RegistrySource,
} from '@ai-primitives-hub/core';
import AdmZip from 'adm-zip';
import fc from 'fast-check';
import * as yaml from 'js-yaml';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AgentPluginsSourceAdapter,
} from '../../src/adapters/agent-plugins-adapter';
import {
  FakeGitHubApi,
} from '../helpers/fake-github-api';
import {
  FixedClock,
} from '../helpers/fixed-clock';

const VALID_SCHEMA = 'https://agent-plugins.dev/schema/v1.0.0/plugin.json';
const RAW_BASE = 'https://raw.githubusercontent.com/owner/repo/main';
const TREE_PATH = '/repos/owner/repo/git/trees/main?recursive=1';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'agent-plugins-test',
    name: 'Agent Plugins Test',
    type: 'skills', // U2 does not register a new SourceType (that is U3); reuse an existing literal.
    url: 'https://github.com/owner/repo',
    enabled: true,
    priority: 0,
    ...overrides
  };
}

function skillMd(fields: { name?: string; description?: string; license?: string } = {}): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '', 'Body.');
  return lines.join('\n');
}

function makeAdapter(overrides: { source?: RegistrySource; githubApi?: FakeGitHubApi; clock?: FixedClock } = {}): AgentPluginsSourceAdapter {
  return new AgentPluginsSourceAdapter(overrides.source ?? makeSource(), overrides.githubApi ?? new FakeGitHubApi(), overrides.clock ?? new FixedClock(0));
}

/** A golden plugin: valid plugin.json, two skills (one invalid), a root mcp.json with a server + input. */
function goldenApi(): FakeGitHubApi {
  return new FakeGitHubApi()
    .seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA, description: 'A demo plugin', license: 'MIT' }))
    .seedText(`${RAW_BASE}/mcp.json`, JSON.stringify({
      mcpServers: { db: { type: 'stdio', command: 'run-db', args: ['--token', '${input:token}'] } },
      inputs: [{ id: 'token', type: 'promptString', description: 'Token', password: true }]
    }))
    .seedJson(TREE_PATH, {
      tree: [
        { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
        { path: 'skills/alpha/ref.md', type: 'blob', sha: 's2' },
        { path: 'skills/no-skillmd/README.md', type: 'blob', sha: 's3' }
      ]
    })
    .seedText(`${RAW_BASE}/skills/alpha/SKILL.md`, skillMd({ name: 'Alpha', description: 'Alpha skill' }));
}

describe('AgentPluginsSourceAdapter', () => {
  describe('constructor', () => {
    it('accepts https:// and git@ GitHub URLs', () => {
      expect(() => makeAdapter()).not.toThrow();
      expect(() => makeAdapter({ source: makeSource({ url: 'git@github.com:owner/repo.git' }) })).not.toThrow();
    });

    it('rejects a non-GitHub URL', () => {
      expect(() => makeAdapter({ source: makeSource({ url: 'https://example.com/owner/repo' }) })).toThrow('Invalid GitHub URL for agent-plugins source');
    });
  });

  describe('fetchBundles', () => {
    it('discovers the plugin and emits a single bundle, skipping the SKILL.md-less skill dir', async () => {
      const [bundle] = await makeAdapter({ githubApi: goldenApi() }).fetchBundles();
      expect(bundle).toMatchObject({
        id: 'agent-plugins-owner-repo-demo-plugin',
        name: 'demo-plugin',
        description: 'A demo plugin',
        license: 'MIT',
        author: 'owner',
        sourceId: 'agent-plugins-test',
        environments: ['claude', 'vscode', 'claude-code'],
        tags: ['agent-plugin', 'skill'],
        repository: 'https://github.com/owner/repo',
        manifestUrl: `${RAW_BASE}/plugin.json`,
        downloadUrl: 'https://github.com/owner/repo/archive/refs/heads/main.zip'
      });
      expect(bundle.version).toMatch(/^hash:[0-9a-f]{64}$/);
    });

    it('returns [] (skip whole plugin) when plugin.json is fatally invalid (missing name)', async () => {
      const api = goldenApi().seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ $schema: VALID_SCHEMA }));
      expect(await makeAdapter({ githubApi: api }).fetchBundles()).toEqual([]);
    });

    it('wraps a plugin.json fetch failure with a descriptive error', async () => {
      await expect(makeAdapter({ githubApi: new FakeGitHubApi() }).fetchBundles()).rejects.toThrow('Failed to fetch agent plugin:');
    });

    it('loads a plugin whose plugin.json has non-fatal issues (resilient keep-valid)', async () => {
      // Unknown extra field → non-fatal in resilient mode; the plugin still loads.
      const api = goldenApi().seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA, unknownField: true }));
      const bundles = await makeAdapter({ githubApi: api }).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('loads the plugin with no MCP when mcp.json is absent (not an error)', async () => {
      // A fresh api with no mcp.json text seeded — readMcp() swallows the 404 and returns no MCP.
      const noMcp = new FakeGitHubApi()
        .seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA }))
        .seedJson(TREE_PATH, { tree: [{ path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' }] })
        .seedText(`${RAW_BASE}/skills/alpha/SKILL.md`, skillMd({ name: 'Alpha' }));
      const bundles = await makeAdapter({ githubApi: noMcp }).fetchBundles();
      expect(bundles).toHaveLength(1);
    });
  });

  describe('downloadBundle → synthesized deployment-manifest.yml (golden)', () => {
    const downloadManifest = async (): Promise<Record<string, unknown>> => {
      const api = goldenApi()
        .seedJson('/repos/owner/repo/contents/skills/alpha', [
          { name: 'SKILL.md', path: 'skills/alpha/SKILL.md', type: 'file', download_url: `${RAW_BASE}/skills/alpha/SKILL.md` },
          { name: 'ref.md', path: 'skills/alpha/ref.md', type: 'file', download_url: `${RAW_BASE}/skills/alpha/ref.md` }
        ])
        .seedBytes(`${RAW_BASE}/skills/alpha/SKILL.md`, new TextEncoder().encode('skill'))
        .seedBytes(`${RAW_BASE}/skills/alpha/ref.md`, new TextEncoder().encode('ref'));
      const adapter = makeAdapter({ githubApi: api });
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
      const entry = new AdmZip(zip).getEntry('deployment-manifest.yml');
      expect(entry).not.toBeNull();
      return yaml.load(entry!.getData().toString('utf8')) as Record<string, unknown>;
    };

    it('emits the full SkillsAdapter field set plus mcpServers (Record) + mcpInputs (array) + skill routes', async () => {
      const manifest = await downloadManifest();
      expect(manifest).toMatchObject({
        id: 'agent-plugins-owner-repo-demo-plugin',
        name: 'demo-plugin',
        metadata: { manifest_version: '1.0', author: 'owner', license: 'MIT' },
        bundle_settings: { compression: 'zip' },
        mcpServers: { db: { type: 'stdio', command: 'run-db', args: ['--token', '${input:token}'] } },
        mcpInputs: [{ id: 'token', type: 'promptString', description: 'Token', password: true }]
      });
      // skill routes
      expect(manifest.prompts).toEqual([
        { id: 'alpha', name: 'Alpha', description: 'Alpha skill', file: 'skills/alpha/SKILL.md', type: 'skill', tags: ['agent-plugin', 'skill'] }
      ]);
      expect(manifest.common).toMatchObject({ directories: ['skills/alpha'] });
    });

    it('throws a descriptive error when the bundle does not match the discovered plugin', async () => {
      await expect(makeAdapter({ githubApi: goldenApi() }).downloadBundle({ id: 'agent-plugins-owner-repo-wrong' } as Bundle)).rejects.toThrow(
        'Failed to download agent plugin agent-plugins-owner-repo-wrong'
      );
    });
  });

  describe('SEC-U2-2 (zip-slip) — archive path safety', () => {
    it('rejects a malicious contents-API filename that would escape via ../', async () => {
      const api = goldenApi()
        .seedJson('/repos/owner/repo/contents/skills/alpha', [
          { name: '../../evil.sh', path: 'skills/alpha/../../evil.sh', type: 'file', download_url: `${RAW_BASE}/evil` }
        ])
        .seedBytes(`${RAW_BASE}/evil`, new TextEncoder().encode('#!/bin/sh'));
      const adapter = makeAdapter({ githubApi: api });
      const [bundle] = await adapter.fetchBundles();
      await expect(adapter.downloadBundle(bundle)).rejects.toThrow(/Unsafe archive entry path rejected/);
    });
  });

  describe('bundle-id synthesis (property)', () => {
    it('is deterministic, safe, and prefix-stable for arbitrary plugin names', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (pluginName) => {
          const api = new FakeGitHubApi()
            .seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ name: pluginName, $schema: VALID_SCHEMA }))
            .seedJson(TREE_PATH, { tree: [{ path: 'skills/a/SKILL.md', type: 'blob', sha: 's1' }] })
            .seedText(`${RAW_BASE}/skills/a/SKILL.md`, skillMd({ name: 'A' }));
          const [b1] = await makeAdapter({ githubApi: api }).fetchBundles();
          const [b2] = await makeAdapter({ githubApi: api }).fetchBundles();
          expect(b1).toBeDefined();
          expect(b1.id).toBe(b2.id); // deterministic
          expect(b1.id.startsWith('agent-plugins-owner-repo-')).toBe(true); // prefix-stable
          expect(b1.id.includes('/')).toBe(false);
          expect(b1.id.includes('..')).toBe(false);
        }),
        { numRuns: 40 }
      );
    });
  });

  // -------------------------------------------------------------------------
  // U7 — reverse-domain namespace (agents/hooks) synthesis
  // -------------------------------------------------------------------------
  describe('namespace agents/hooks synthesis (U7)', () => {
    const AGENTS_DIR = `${AGENT_PLUGINS_EXTENSION_NS}/agents`;
    const HOOKS_DIR = `${AGENT_PLUGINS_EXTENSION_NS}/hooks`;

    /** A golden plugin that ALSO carries a reverse-domain agent + hook. */
    const namespaceApi = (): FakeGitHubApi =>
      new FakeGitHubApi()
        .seedText(`${RAW_BASE}/plugin.json`, JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA, description: 'A demo', license: 'MIT' }))
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
            { path: `${AGENTS_DIR}/reviewer.md`, type: 'blob', sha: 's2' },
            { path: `${HOOKS_DIR}/hooks.json`, type: 'blob', sha: 's3' }
          ]
        })
        .seedText(`${RAW_BASE}/skills/alpha/SKILL.md`, skillMd({ name: 'Alpha', description: 'Alpha skill' }))
        // hooks.json is JSON → fetched during discovery for the resilient parse check.
        .seedText(`${RAW_BASE}/${HOOKS_DIR}/hooks.json`, JSON.stringify({ hooks: [{ event: 'PostToolUse' }] }))
        // Archive fetches each namespace file's bytes via its raw URL.
        .seedBytes(`${RAW_BASE}/${AGENTS_DIR}/reviewer.md`, new TextEncoder().encode('# Reviewer agent'))
        .seedBytes(`${RAW_BASE}/${HOOKS_DIR}/hooks.json`, new TextEncoder().encode('{"hooks":[]}'))
        // Skill files for the archive step.
        .seedJson('/repos/owner/repo/contents/skills/alpha', [
          { name: 'SKILL.md', path: 'skills/alpha/SKILL.md', type: 'file', download_url: `${RAW_BASE}/skills/alpha/SKILL.md` }
        ])
        .seedBytes(`${RAW_BASE}/skills/alpha/SKILL.md`, new TextEncoder().encode('skill'));

    it('parses + validates + maps agents/hooks and synthesizes them into the manifest and the ZIP', async () => {
      const adapter = makeAdapter({ githubApi: namespaceApi() });
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);

      // The namespace files are baked into the bundle alongside the skill.
      const entries = new AdmZip(zip).getEntries().map((entry) => entry.entryName);
      expect(entries).toContain(`${AGENTS_DIR}/reviewer.md`);
      expect(entries).toContain(`${HOOKS_DIR}/hooks.json`);
      expect(entries).toContain('skills/alpha/SKILL.md');

      const manifest = yaml.load(new AdmZip(zip).getEntry('deployment-manifest.yml')!.getData().toString('utf8')) as Record<string, unknown>;
      const prompts = manifest.prompts as { file: string; type: string }[];
      // Existing skill route is preserved (additive), plus agent + hook routes mapped to existing kinds.
      expect(prompts).toContainEqual(expect.objectContaining({ file: 'skills/alpha/SKILL.md', type: 'skill' }));
      expect(prompts).toContainEqual(expect.objectContaining({ file: `${AGENTS_DIR}/reviewer.md`, type: 'agent' }));
      expect(prompts).toContainEqual(expect.objectContaining({ file: `${HOOKS_DIR}/hooks.json`, type: 'hook' }));
      expect(manifest.common).toMatchObject({ files: [`${AGENTS_DIR}/reviewer.md`, `${HOOKS_DIR}/hooks.json`] });
    });

    it('SEC-U7-2: rejects a server-supplied namespace tree path that escapes via ../ (routed through the SEC-U2-2 guard)', async () => {
      const api = namespaceApi().seedJson(TREE_PATH, {
        tree: [
          { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
          { path: `${AGENTS_DIR}/../../evil.md`, type: 'blob', sha: 'evil' }
        ]
      });
      const adapter = makeAdapter({ githubApi: api });
      const [bundle] = await adapter.fetchBundles();
      await expect(adapter.downloadBundle(bundle)).rejects.toThrow(/Unsafe archive entry path rejected/);
    });

    it('SEC-U7-2 property: no adversarial namespace path (../, absolute) is ever written to the bundle', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('../../escape.md', '../secret.md', 'a/../../b.md', 'sub/../../../x.md'),
          async (evilRel) => {
            const api = namespaceApi().seedJson(TREE_PATH, {
              tree: [
                { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
                { path: `${AGENTS_DIR}/${evilRel}`, type: 'blob', sha: 'evil' }
              ]
            });
            const adapter = makeAdapter({ githubApi: api });
            const [bundle] = await adapter.fetchBundles();
            await expect(adapter.downloadBundle(bundle)).rejects.toThrow(/Unsafe archive entry path rejected/);
          }
        ),
        { numRuns: 20 }
      );
    });

    it('SEC-U7-1: skips a malformed hooks.json namespace entry but still emits the bundle (resilient)', async () => {
      const api = namespaceApi()
        .seedJson(TREE_PATH, {
          tree: [
            { path: 'skills/alpha/SKILL.md', type: 'blob', sha: 's1' },
            { path: `${HOOKS_DIR}/broken.json`, type: 'blob', sha: 'b' }
          ]
        })
        .seedText(`${RAW_BASE}/${HOOKS_DIR}/broken.json`, '{ not json');
      const adapter = makeAdapter({ githubApi: api });
      const [bundle] = await adapter.fetchBundles();
      const manifest = yaml.load(new AdmZip(await adapter.downloadBundle(bundle)).getEntry('deployment-manifest.yml')!.getData().toString('utf8')) as Record<string, unknown>;
      // The broken hook is skipped; only the skill route remains.
      expect((manifest.prompts as { type: string }[]).map((prompt) => prompt.type)).toEqual(['skill']);
    });
  });

  describe('validate', () => {
    it('is invalid when the repository cannot be accessed', async () => {
      const result = await makeAdapter({ githubApi: new FakeGitHubApi() }).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Agent plugins repository validation failed');
    });

    it('is invalid with a specific message when plugin.json is missing (404)', async () => {
      const api = new FakeGitHubApi().seedJson('/repos/owner/repo', { name: 'repo' });
      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain(`Missing required 'plugin.json'`);
    });

    it('is valid with bundlesFound=1 for the golden plugin', async () => {
      const api = goldenApi().seedJson('/repos/owner/repo', { name: 'repo' });
      const result = await makeAdapter({ githubApi: api }).validate();
      expect(result).toMatchObject({ valid: true, bundlesFound: 1 });
    });
  });
});
