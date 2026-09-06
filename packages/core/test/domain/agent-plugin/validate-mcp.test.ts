/**
 * Tests for `validateAgentPluginMcp` — the pure root `mcp.json` schema
 * validator (the SEPARATE MCP check U4 authoring runs in strict mode).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateAgentPluginMcp,
} from '../../../src/domain/agent-plugin/validate-mcp';

describe('validateAgentPluginMcp — happy path', () => {
  it('accepts a conformant mcp.json in strict mode', () => {
    const mcp = {
      mcpServers: { server: { type: 'stdio', command: 'node', args: ['s.js'] } },
      inputs: [{ id: 'token', type: 'promptString', password: true }]
    };
    const result = validateAgentPluginMcp(mcp, 'strict');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts an empty object (no required top-level fields)', () => {
    expect(validateAgentPluginMcp({}, 'strict').valid).toBe(true);
  });
});

describe('validateAgentPluginMcp — parse guard (fatal both modes)', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'nope']
  ])('rejects a non-object root: %s', (_label, input) => {
    for (const mode of ['strict', 'resilient'] as const) {
      const result = validateAgentPluginMcp(input, mode);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('root: not an object');
    }
  });
});

describe('validateAgentPluginMcp — schema violations', () => {
  it('fails strict mode for an invalid server transport type', () => {
    const result = validateAgentPluginMcp(
      { mcpServers: { s: { type: 'telepathy' } } },
      'strict'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails strict mode for an unknown top-level field (closed schema)', () => {
    const result = validateAgentPluginMcp({ bogus: true }, 'strict');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('bogus'))).toBe(true);
  });

  it('passes resilient mode with schema issues reported as warnings', () => {
    const result = validateAgentPluginMcp({ bogus: true }, 'resilient');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
  });
});
