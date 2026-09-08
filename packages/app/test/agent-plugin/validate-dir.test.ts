/**
 * Tests for `validateAgentPluginDir` — the app-layer orchestration that reads
 * a local plugin directory and delegates strict rule checks to core (U4).
 */
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateAgentPluginDir,
} from '../../src/agent-plugin/validate-dir';

describe('validateAgentPluginDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'app-plugin-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is valid for a conformant plugin.json', async () => {
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ $schema: 'x', name: 'my-plugin', version: '1.0.0' })
    );
    const result = validateAgentPluginDir(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.pluginName).toBe('my-plugin');
    expect(result.hasMcp).toBe(false);
  });

  it('is invalid (strict) for a malformed name', async () => {
    await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ $schema: 'x', name: 'Invalid_Name' }));
    const result = validateAgentPluginDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('plugin.json: name:'))).toBe(true);
  });

  it('is invalid when plugin.json is missing', async () => {
    const result = validateAgentPluginDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('plugin.json: not found');
  });

  it('is invalid when plugin.json is not valid JSON', async () => {
    await writeFile(path.join(dir, 'plugin.json'), '{ not json');
    const result = validateAgentPluginDir(dir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('plugin.json: invalid JSON');
  });

  it('validates a present mcp.json and surfaces its schema errors (strict)', async () => {
    await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ $schema: 'x', name: 'my-plugin' }));
    await writeFile(
      path.join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { s: { type: 'not-a-transport' } } })
    );
    const result = validateAgentPluginDir(dir);
    expect(result.hasMcp).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('mcp.json:'))).toBe(true);
  });

  it('stays valid when a present mcp.json conforms', async () => {
    await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ $schema: 'x', name: 'my-plugin' }));
    await writeFile(
      path.join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { s: { type: 'stdio', command: 'node', args: ['s.js'] } } })
    );
    const result = validateAgentPluginDir(dir);
    expect(result.hasMcp).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
