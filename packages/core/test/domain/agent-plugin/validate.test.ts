/**
 * Unit tests for domain/agent-plugin/validate.ts.
 *
 * Covers the U1 algorithm (business-logic-model.md): parse guard, required
 * $schema/name (fatal), name grammar (R1, non-fatal), closed-manifest schema
 * validation, and the strict/resilient mode branch (R3).
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateAgentPluginManifest,
  validateAgentPluginName,
} from '../../../src/domain/agent-plugin/validate';

const validManifest = {
  $schema: 'https://agent-plugins.org/schemas/plugin.schema.json',
  name: 'my-plugin',
  version: '1.0.0',
  description: 'A valid plugin',
  skills: [],
  mcpServers: []
};

describe('validateAgentPluginManifest — happy path', () => {
  it('accepts a conformant manifest in strict mode', () => {
    const result = validateAgentPluginManifest(validManifest, 'strict');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a conformant manifest in resilient mode', () => {
    const result = validateAgentPluginManifest(validManifest, 'resilient');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toBeUndefined();
  });

  it('accepts a minimal manifest with only the required fields', () => {
    const minimal = { $schema: 'x', name: 'a' };
    expect(validateAgentPluginManifest(minimal, 'strict').valid).toBe(true);
  });
});

describe('validateAgentPluginManifest — parse guard (fatal)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string', 'not-an-object'],
    ['number', 42]
  ])('rejects a non-object root: %s', (_label, input) => {
    for (const mode of ['strict', 'resilient'] as const) {
      const result = validateAgentPluginManifest(input, mode);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('root: not an object');
    }
  });
});

describe('validateAgentPluginManifest — required fields (fatal, both modes)', () => {
  it('rejects a missing $schema in both modes', () => {
    const manifest = { name: 'my-plugin' };
    const strict = validateAgentPluginManifest(manifest, 'strict');
    const resilient = validateAgentPluginManifest(manifest, 'resilient');
    expect(strict.valid).toBe(false);
    expect(resilient.valid).toBe(false);
    expect(strict.errors.some((e) => e.includes('$schema'))).toBe(true);
    expect(resilient.errors.some((e) => e.includes('$schema'))).toBe(true);
  });

  it('rejects a missing name in both modes', () => {
    const manifest = { $schema: 'x' };
    expect(validateAgentPluginManifest(manifest, 'strict').valid).toBe(false);
    expect(validateAgentPluginManifest(manifest, 'resilient').valid).toBe(false);
  });

  it('rejects a mistyped $schema/name (non-string) as fatal', () => {
    const manifest = { $schema: 123, name: true };
    const resilient = validateAgentPluginManifest(manifest, 'resilient');
    expect(resilient.valid).toBe(false);
    expect(resilient.errors.some((e) => e.includes('$schema'))).toBe(true);
    expect(resilient.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('keeps the valid=false ⇒ errors non-empty invariant on fatal (resilient)', () => {
    const result = validateAgentPluginManifest({ name: 'my-plugin' }, 'resilient');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('validateAgentPluginManifest — unknown top-level field (closed manifest, R2)', () => {
  const manifest = { $schema: 'x', name: 'my-plugin', bogus: true };

  it('fails strict mode with the unknown field in errors', () => {
    const result = validateAgentPluginManifest(manifest, 'strict');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('bogus'))).toBe(true);
  });

  it('passes resilient mode with the unknown field reported as a warning', () => {
    const result = validateAgentPluginManifest(manifest, 'resilient');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings?.some((w) => w.includes('bogus'))).toBe(true);
  });
});

describe('validateAgentPluginManifest — malformed name (R1, non-fatal)', () => {
  const manifest = { $schema: 'x', name: 'Invalid_Name' };

  it('fails strict mode with the name issue in errors', () => {
    const result = validateAgentPluginManifest(manifest, 'strict');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('name:'))).toBe(true);
  });

  it('passes resilient mode with the name issue reported as a warning', () => {
    const result = validateAgentPluginManifest(manifest, 'resilient');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings?.some((w) => w.startsWith('name:'))).toBe(true);
  });
});

describe('validateAgentPluginName — grammar (R1)', () => {
  it.each(['a', 'my-plugin', 'a.b.c', 'plugin1', 'a1-b2.c3'])(
    'accepts a well-formed name: %s',
    (name) => {
      expect(validateAgentPluginName(name)).toBeNull();
    }
  );

  it('rejects an empty name (length)', () => {
    expect(validateAgentPluginName('')).toContain('characters');
  });

  it('rejects a name longer than 64 characters', () => {
    expect(validateAgentPluginName('a'.repeat(65))).toContain('characters');
  });

  it('accepts a name at the 64-character boundary', () => {
    expect(validateAgentPluginName('a'.repeat(64))).toBeNull();
  });

  it.each(['My-Plugin', 'plugin_name', 'plug in', 'héllo'])(
    'rejects disallowed characters: %s',
    (name) => {
      expect(validateAgentPluginName(name)).not.toBeNull();
    }
  );

  it.each(['-plugin', 'plugin-', '.plugin', 'plugin.'])(
    'rejects non-alphanumeric bounds: %s',
    (name) => {
      expect(validateAgentPluginName(name)).not.toBeNull();
    }
  );

  it.each(['a--b', 'a..b'])('rejects consecutive separators: %s', (name) => {
    expect(validateAgentPluginName(name)).toContain('consecutive');
  });
});
