import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Bundle,
  RegistrySource,
} from '@ai-primitives-hub/core';
import AdmZip from 'adm-zip';
import fc from 'fast-check';
import * as yaml from 'js-yaml';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  LocalAgentPluginsAdapter,
} from '../../src/adapters/local-agent-plugins-adapter';
import {
  NodeFileSystem,
} from '../../src/fs/node-filesystem';
import {
  FixedClock,
} from '../helpers/fixed-clock';
import {
  InMemoryFileSystem,
} from '../helpers/in-memory-filesystem';
import {
  createTempDir,
} from '../helpers/temp-dir';

const VALID_SCHEMA = 'https://agent-plugins.dev/schema/v1.0.0/plugin.json';
const ROOT = '/plugins-root';

function makeSource(overrides: Partial<RegistrySource> = {}): RegistrySource {
  return {
    id: 'local-agent-plugins-test',
    name: 'Local Agent Plugins Test',
    type: 'local-skills', // U2 registers no new SourceType (U3 does); reuse an existing literal.
    url: ROOT,
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

function goldenFs(): InMemoryFileSystem {
  const fsDouble = new InMemoryFileSystem();
  fsDouble.seed(`${ROOT}/plugin.json`, JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA, description: 'A demo', license: 'MIT' }));
  fsDouble.seed(`${ROOT}/mcp.json`, JSON.stringify({
    mcpServers: { db: { type: 'stdio', command: 'run-db' } },
    inputs: [{ id: 'token', type: 'promptString' }]
  }));
  fsDouble.seed(`${ROOT}/skills/alpha/SKILL.md`, skillMd({ name: 'Alpha', description: 'Alpha skill' }));
  fsDouble.seed(`${ROOT}/skills/alpha/ref.md`, '# Reference');
  return fsDouble;
}

function makeAdapter(fsDouble: InMemoryFileSystem, source: RegistrySource = makeSource()): LocalAgentPluginsAdapter {
  return new LocalAgentPluginsAdapter(source, fsDouble, new FixedClock(0));
}

/**
 * Write a real on-disk plugin under a fresh temp dir; returns [root, cleanup].
 * @param prefix
 * @param opts
 * @param opts.mcp
 * @param opts.brokenSkill
 */
function writeRealPlugin(prefix: string, opts: { mcp?: boolean; brokenSkill?: boolean } = {}): [string, () => void] {
  const [root, cleanup] = createTempDir(prefix);
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'demo-plugin', $schema: VALID_SCHEMA, description: 'A demo', license: 'MIT' }));
  if (opts.mcp) {
    fs.writeFileSync(path.join(root, 'mcp.json'), JSON.stringify({
      mcpServers: { db: { type: 'stdio', command: 'run-db' } },
      inputs: [{ id: 'token', type: 'promptString' }]
    }));
  }
  fs.mkdirSync(path.join(root, 'skills', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), skillMd({ name: 'Alpha', description: 'Alpha skill' }));
  fs.writeFileSync(path.join(root, 'skills', 'alpha', 'ref.md'), '# Reference');
  if (opts.brokenSkill) {
    fs.mkdirSync(path.join(root, 'skills', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'broken', 'README.md'), 'no skill md');
  }
  return [root, cleanup];
}

function makeRealAdapter(root: string): LocalAgentPluginsAdapter {
  return new LocalAgentPluginsAdapter(makeSource({ url: root }), new NodeFileSystem(), new FixedClock(0));
}

function readZipManifest(zip: Buffer): Record<string, unknown> {
  const entry = new AdmZip(zip).getEntry('deployment-manifest.yml');
  expect(entry).not.toBeNull();
  return yaml.load(entry!.getData().toString('utf8')) as Record<string, unknown>;
}

describe('LocalAgentPluginsAdapter', () => {
  describe('constructor', () => {
    it('rejects a non-local URL', () => {
      expect(() => makeAdapter(new InMemoryFileSystem(), makeSource({ url: 'not-a-path' }))).toThrow('Invalid local agent-plugins path');
    });

    it('accepts file://, absolute, ~/, ./ URLs and never requires auth', () => {
      for (const url of ['file:///plugins-root', '/plugins-root', '~/plugins-root', './plugins-root']) {
        expect(() => makeAdapter(new InMemoryFileSystem(), makeSource({ url }))).not.toThrow();
      }
      expect(makeAdapter(new InMemoryFileSystem()).requiresAuthentication()).toBe(false);
    });
  });

  describe('fetchBundles (in-memory discovery)', () => {
    it('discovers the plugin and emits one bundle', async () => {
      const [bundle] = await makeAdapter(goldenFs()).fetchBundles();
      expect(bundle).toMatchObject({
        id: 'local-agent-plugins-plugins-root-demo-plugin',
        name: 'demo-plugin',
        description: 'A demo',
        license: 'MIT',
        author: 'Local',
        tags: ['agent-plugin', 'skill', 'local']
      });
      expect(bundle.version).toMatch(/^hash:[0-9a-f]{64}$/);
    });

    it('returns [] when plugin.json is fatally invalid (missing $schema)', async () => {
      const fsDouble = new InMemoryFileSystem();
      fsDouble.seed(`${ROOT}/plugin.json`, JSON.stringify({ name: 'x' }));
      fsDouble.seed(`${ROOT}/skills/a/SKILL.md`, skillMd({ name: 'A' }));
      expect(await makeAdapter(fsDouble).fetchBundles()).toEqual([]);
    });

    it('reports a plugin with zero installable skills as one bundle (not fatal)', async () => {
      const fsDouble = new InMemoryFileSystem();
      fsDouble.seed(`${ROOT}/plugin.json`, JSON.stringify({ name: 'empty', $schema: VALID_SCHEMA }));
      fsDouble.seed(`${ROOT}/skills/.keep`, '');
      const bundles = await makeAdapter(fsDouble).fetchBundles();
      expect(bundles).toHaveLength(1);
    });

    it('throws "Plugin not found" for a mismatched bundle id before archiving', async () => {
      await expect(makeAdapter(goldenFs()).downloadBundle({ id: 'local-agent-plugins-plugins-root-wrong' } as Bundle)).rejects.toThrow(
        'Failed to download local agent plugin'
      );
    });
  });

  describe('bundle-id synthesis (property, in-memory)', () => {
    it('is deterministic, safe, and prefix-stable for arbitrary plugin names', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (pluginName) => {
          const fsDouble = new InMemoryFileSystem();
          fsDouble.seed(`${ROOT}/plugin.json`, JSON.stringify({ name: pluginName, $schema: VALID_SCHEMA }));
          fsDouble.seed(`${ROOT}/skills/a/SKILL.md`, skillMd({ name: 'A' }));
          const [b1] = await makeAdapter(fsDouble).fetchBundles();
          const [b2] = await makeAdapter(fsDouble).fetchBundles();
          expect(b1).toBeDefined();
          expect(b1.id).toBe(b2.id);
          expect(b1.id.startsWith('local-agent-plugins-plugins-root-')).toBe(true);
          expect(b1.id.includes('/')).toBe(false);
          expect(b1.id.includes('..')).toBe(false);
        }),
        { numRuns: 40 }
      );
    });
  });

  describe('validate (in-memory)', () => {
    it('is invalid when plugin.json is missing', async () => {
      const fsDouble = new InMemoryFileSystem();
      fsDouble.seed(`${ROOT}/.keep`, '');
      const result = await makeAdapter(fsDouble).validate();
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain(`Missing required 'plugin.json'`);
    });

    it('is valid with bundlesFound=1 for the golden plugin', async () => {
      const result = await makeAdapter(goldenFs()).validate();
      expect(result).toMatchObject({ valid: true, bundlesFound: 1 });
    });
  });

  // downloadBundle bakes files via createBundleArchive, which runs the
  // node:fs-based SEC-U2-7 guard — so these must use a real temp-dir fixture.
  describe('downloadBundle → synthesized manifest (real temp-dir golden)', () => {
    const cleanups: (() => void)[] = [];
    afterEach(() => {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
    });

    it('bakes the deployment-manifest.yml with mcpServers/mcpInputs + skill routes into the ZIP', async () => {
      const [root, cleanup] = writeRealPlugin('u2-golden-', { mcp: true });
      cleanups.push(cleanup);
      const adapter = makeRealAdapter(root);
      const [bundle] = await adapter.fetchBundles();
      const zip = await adapter.downloadBundle(bundle);
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));

      const manifest = readZipManifest(zip);
      expect(manifest).toMatchObject({
        id: `local-agent-plugins-${path.basename(root)}-demo-plugin`,
        name: 'demo-plugin',
        metadata: { manifest_version: '1.0', author: 'Local', license: 'MIT' },
        mcpServers: { db: { type: 'stdio', command: 'run-db' } },
        mcpInputs: [{ id: 'token', type: 'promptString' }]
      });
      expect(manifest.prompts).toEqual([
        { id: 'alpha', name: 'Alpha', description: 'Alpha skill', file: 'skills/alpha/SKILL.md', type: 'skill', tags: ['agent-plugin', 'skill', 'local'] }
      ]);
    });

    it('routes only the valid skill when a skills/ subdir lacks SKILL.md (resilient skip-invalid, keep-valid)', async () => {
      const [root, cleanup] = writeRealPlugin('u2-skip-', { brokenSkill: true });
      cleanups.push(cleanup);
      const adapter = makeRealAdapter(root);
      const [bundle] = await adapter.fetchBundles();
      const manifest = readZipManifest(await adapter.downloadBundle(bundle));
      expect(manifest.common).toMatchObject({ directories: ['skills/alpha'] });
    });

    it('omits mcpServers/mcpInputs from the manifest when there is no mcp.json', async () => {
      const [root, cleanup] = writeRealPlugin('u2-nomcp-');
      cleanups.push(cleanup);
      const adapter = makeRealAdapter(root);
      const [bundle] = await adapter.fetchBundles();
      const manifest = readZipManifest(await adapter.downloadBundle(bundle));
      expect(manifest.mcpServers).toBeUndefined();
      expect(manifest.mcpInputs).toBeUndefined();
    });
  });

  // SEC-U2-7 uses node:fs realpath/lstat directly, so it must run against a
  // real temp-dir fixture (the in-memory double has no symlink concept).
  describe('SEC-U2-7 (local symlink escape) — real temp-dir fixture', () => {
    const cleanups: (() => void)[] = [];
    afterEach(() => {
      while (cleanups.length > 0) {
        cleanups.pop()?.();
      }
    });

    it('rejects a skill file that is a symlink escaping the plugin root', async () => {
      const [root, cleanupRoot] = writeRealPlugin('u2-evil-');
      const [outside, cleanupOutside] = createTempDir('u2-secret-');
      cleanups.push(cleanupRoot, cleanupOutside);

      const secret = path.join(outside, 'secret.txt');
      fs.writeFileSync(secret, 'TOP SECRET');
      // A skill "file" that is actually a symlink pointing outside the plugin root.
      fs.symlinkSync(secret, path.join(root, 'skills', 'alpha', 'leak.txt'));

      const adapter = makeRealAdapter(root);
      const [bundle] = await adapter.fetchBundles();
      await expect(adapter.downloadBundle(bundle)).rejects.toThrow(/escaping the plugin root \(SEC-U2-7\)/);
    });
  });
});
