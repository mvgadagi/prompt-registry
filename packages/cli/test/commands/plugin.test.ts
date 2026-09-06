/**
 * `plugin validate` and `plugin build` command tests (U4 authoring-cli).
 *
 * Uses a real `NodeFileSystem` against a real temp directory (the app
 * validate helper reads via `node:fs`, and `plugin build` shells out to a
 * real zip stream, neither of which can be stubbed through `Context.fs`),
 * following the existing `collection-bundle.test.ts` pattern.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateManifest,
} from '@ai-primitives-hub/core';
import {
  NodeFileSystem,
  ZipBundleExtractor,
} from '@ai-primitives-hub/infra';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  normalizePluginBundleEntries,
  PluginBuildCommand,
} from '../../src/commands/plugin-build';
import {
  PluginValidateCommand,
} from '../../src/commands/plugin-validate';
import {
  runCommand,
} from '../../src/framework';

const COMMAND_CLASSES = [PluginValidateCommand, PluginBuildCommand];

interface JsonEnvelope<T> {
  status: string;
  data: T;
  warnings: string[];
}

const VALID_PLUGIN_JSON = JSON.stringify({
  $schema: 'https://agent-plugins.dev/schemas/v1/plugin.json',
  name: 'my-plugin',
  version: '1.0.0',
  description: 'A test plugin'
});

describe('plugin validate / plugin build commands', () => {
  let workspace: string;

  const run = (argv: string[]): ReturnType<typeof runCommand> => runCommand(argv, {
    commandClasses: COMMAND_CLASSES,
    context: {
      cwd: workspace,
      fs: new NodeFileSystem(),
      env: {}
    }
  });

  const parseJson = <T>(stdout: string): JsonEnvelope<T> => JSON.parse(stdout) as JsonEnvelope<T>;

  const writeValidPlugin = async (dir: string): Promise<void> => {
    await mkdir(path.join(dir, 'skills', 'hello'), { recursive: true });
    await writeFile(path.join(dir, 'plugin.json'), VALID_PLUGIN_JSON);
    await writeFile(
      path.join(dir, 'skills', 'hello', 'SKILL.md'),
      '---\nname: hello\ndescription: A hello skill for testing.\n---\n\n# Hello\n'
    );
  };

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'cli-plugin-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('plugin validate', () => {
    it('exits 0 for a valid plugin directory', async () => {
      await writeValidPlugin(path.join(workspace, 'plugins', 'my-plugin'));
      const result = await run(['plugin', 'validate', 'plugins/my-plugin', '-o', 'json']);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ valid: boolean; pluginName: string }>(result.stdout);
      expect(envelope.data.valid).toBe(true);
      expect(envelope.data.pluginName).toBe('my-plugin');
    });

    it('also validates a present mcp.json and stays valid', async () => {
      const dir = path.join(workspace, 'plugins', 'my-plugin');
      await writeValidPlugin(dir);
      await writeFile(
        path.join(dir, 'mcp.json'),
        JSON.stringify({ mcpServers: { server: { type: 'stdio', command: 'node' } } })
      );
      const result = await run(['plugin', 'validate', 'plugins/my-plugin', '-o', 'json']);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(parseJson<{ valid: boolean }>(result.stdout).data.valid).toBe(true);
    });

    it('exits non-zero for a malformed plugin name (strict, FR-1.3)', async () => {
      const dir = path.join(workspace, 'plugins', 'bad');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'plugin.json'),
        JSON.stringify({ $schema: 'x', name: 'Invalid_Name' })
      );
      const result = await run(['plugin', 'validate', 'plugins/bad', '-o', 'json']);
      expect(result.exitCode).toBe(1);
      const envelope = parseJson<{ valid: boolean; errors: string[] }>(result.stdout);
      expect(envelope.data.valid).toBe(false);
      expect(envelope.data.errors.some((e) => e.startsWith('plugin.json: name:'))).toBe(true);
    });

    it('exits non-zero for an unknown top-level field (closed manifest, strict)', async () => {
      const dir = path.join(workspace, 'plugins', 'bogus');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'plugin.json'),
        JSON.stringify({ $schema: 'x', name: 'ok-plugin', bogus: true })
      );
      const result = await run(['plugin', 'validate', 'plugins/bogus', '-o', 'json']);
      expect(result.exitCode).toBe(1);
      expect(parseJson<{ valid: boolean }>(result.stdout).data.valid).toBe(false);
    });

    it('exits non-zero when plugin.json is absent', async () => {
      await mkdir(path.join(workspace, 'plugins', 'empty'), { recursive: true });
      const result = await run(['plugin', 'validate', 'plugins/empty', '-o', 'json']);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('plugin build', () => {
    it('writes deployment-manifest.yml + <id>.bundle.zip for a valid plugin', async () => {
      await writeValidPlugin(path.join(workspace, 'plugins', 'my-plugin'));
      const result = await run([
        'plugin', 'build', 'plugins/my-plugin', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{
        pluginId: string;
        zipAsset: string;
        manifestAsset: string;
        entryCount: number;
      }>(result.stdout);
      expect(envelope.data.pluginId).toBe('my-plugin');
      expect(envelope.data.zipAsset).toContain('my-plugin.bundle.zip');
      expect(envelope.data.entryCount).toBe(2); // plugin.json + skills/hello/SKILL.md

      const manifestYaml = await readFile(envelope.data.manifestAsset, 'utf8');
      expect(manifestYaml).toContain('id: my-plugin');

      const files = await new ZipBundleExtractor().extract(await readFile(envelope.data.zipAsset));
      const manifest = validateManifest(files, { expectedId: 'my-plugin', expectedVersion: '1.0.0' });
      expect(manifest).toMatchObject({ id: 'my-plugin', version: '1.0.0', name: 'my-plugin' });
      expect([...files.keys()].toSorted()).toEqual([
        'deployment-manifest.yml',
        'plugin.json',
        'skills/hello/SKILL.md'
      ]);
    });

    it('bounds the entry set: root secrets are excluded (SEC-U4-5)', async () => {
      const dir = path.join(workspace, 'plugins', 'my-plugin');
      await writeValidPlugin(dir);
      await writeFile(path.join(dir, '.env'), 'SECRET=shhh\n');
      await writeFile(path.join(dir, 'README.md'), '# secret notes\n');
      const result = await run([
        'plugin', 'build', 'plugins/my-plugin', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const envelope = parseJson<{ zipAsset: string }>(result.stdout);
      const files = await new ZipBundleExtractor().extract(await readFile(envelope.data.zipAsset));
      const keys = [...files.keys()];
      expect(keys).not.toContain('.env');
      expect(keys).not.toContain('README.md');
    });

    it('aborts non-zero and writes NO artifact for an invalid plugin (SEC-U4-1)', async () => {
      const dir = path.join(workspace, 'plugins', 'bad');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'plugin.json'),
        JSON.stringify({ $schema: 'x', name: 'Invalid_Name' })
      );
      const result = await run([
        'plugin', 'build', 'plugins/bad', '--version', '1.0.0', '-o', 'json'
      ]);
      expect(result.exitCode).toBe(1);
      // No bundle output directory was created.
      await expect(stat(path.join(workspace, 'dist', 'Invalid_Name'))).rejects.toThrow();
      await expect(stat(path.join(workspace, 'dist', 'bad'))).rejects.toThrow();
    });
  });

  describe('normalizePluginBundleEntries (SEC-U4-2)', () => {
    const bytes = new Uint8Array([1]);

    it('accepts and sorts safe plugin-relative entry paths', () => {
      const out = normalizePluginBundleEntries([
        { path: 'skills/hello/SKILL.md', bytes },
        { path: 'plugin.json', bytes }
      ]);
      expect(out.map((e) => e.path)).toEqual(['plugin.json', 'skills/hello/SKILL.md']);
    });

    it('rejects a traversal (../) entry path', () => {
      expect(() => normalizePluginBundleEntries([{ path: '../evil', bytes }])).toThrow(/traverse outside repo/);
    });

    it('rejects a nested traversal that escapes the root', () => {
      expect(() => normalizePluginBundleEntries([{ path: 'skills/../../evil', bytes }]))
        .toThrow(/traverse outside repo/);
    });

    it('rejects an absolute (double-slash) entry path', () => {
      expect(() => normalizePluginBundleEntries([{ path: '//etc/passwd', bytes }]))
        .toThrow(/repo-root relative/);
    });
  });
});
