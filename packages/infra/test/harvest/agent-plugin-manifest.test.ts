import fc from 'fast-check';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildAgentPluginPackage,
  foldMcpJson,
  isSafeArchiveEntryPath,
  mcpServerDefsFromRecord,
  mcpServersRecordFromDefs,
  parseAgentPluginManifest,
  sanitizeBundleIdSegment,
} from '../../src/harvest/agent-plugin-manifest';

const VALID_SCHEMA = 'https://agent-plugins.dev/schema/v1.0.0/plugin.json';

describe('parseAgentPluginManifest', () => {
  it('parses a well-formed plugin.json object', () => {
    const obj = parseAgentPluginManifest(JSON.stringify({ name: 'my-plugin', $schema: VALID_SCHEMA }));
    expect(obj).toMatchObject({ name: 'my-plugin', $schema: VALID_SCHEMA });
  });

  it('throws a descriptive error on invalid JSON (reused parse guard)', () => {
    expect(() => parseAgentPluginManifest('{ not json')).toThrow('plugin manifest parse error');
  });

  it('throws when the JSON root is not an object', () => {
    expect(() => parseAgentPluginManifest('[1, 2, 3]')).toThrow('root is not an object');
  });
});

describe('foldMcpJson', () => {
  it('folds the v1 top-level mcpServers key into a servers Record (helper reuse)', () => {
    const raw = JSON.stringify({
      mcpServers: {
        db: { type: 'stdio', command: 'run-db', args: ['--port', '5432'] },
        remote: { type: 'http', url: 'https://mcp.example.com' }
      }
    });
    const folded = foldMcpJson(raw);
    expect(Object.keys(folded.servers).toSorted()).toEqual(['db', 'remote']);
    expect(folded.servers.db).toMatchObject({ type: 'stdio', command: 'run-db' });
    expect(folded.inputs).toEqual([]);
  });

  it('derives inputs separately (the helper does not fold inputs)', () => {
    const raw = JSON.stringify({
      mcpServers: {},
      inputs: [
        { id: 'token', type: 'promptString', description: 'API token', password: true },
        { id: 'region', type: 'pickString', options: ['eu', 'us'], default: 'eu' },
        { id: 'bad' }, // dropped — no `type`
        'not-an-object' // dropped
      ]
    });
    const folded = foldMcpJson(raw);
    expect(folded.inputs).toEqual([
      { id: 'token', type: 'promptString', description: 'API token', password: true },
      { id: 'region', type: 'pickString', options: ['eu', 'us'], default: 'eu' }
    ]);
  });

  it('returns empty servers/inputs for an empty mcp.json object', () => {
    expect(foldMcpJson('{}')).toEqual({ servers: {}, inputs: [] });
  });
});

describe('mcpServerDefsFromRecord / mcpServersRecordFromDefs', () => {
  it('converts a servers Record to McpServerDef[] and round-trips back', () => {
    const record = {
      db: { type: 'stdio', command: 'run-db', args: ['--verbose'] },
      api: { type: 'http', url: 'https://api.example.com', headers: { Authorization: 'Bearer x' } }
    };
    const defs = mcpServerDefsFromRecord(record);
    expect(defs).toContainEqual({ name: 'db', type: 'stdio', command: 'run-db', args: ['--verbose'] });
    expect(mcpServersRecordFromDefs(defs)).toEqual(record);
  });

  it('treats a non-object server config as an empty config', () => {
    expect(mcpServerDefsFromRecord({ weird: 42 })).toEqual([{ name: 'weird' }]);
  });
});

describe('buildAgentPluginPackage', () => {
  const manifest = { name: 'my-plugin', $schema: VALID_SCHEMA };

  it('builds a package on a valid manifest, folding MCP servers to McpServerDef[] and keeping inputs', () => {
    const result = buildAgentPluginPackage({
      manifest,
      skills: [{ name: 'Alpha', path: 'skills/alpha' }],
      mcp: { servers: { db: { type: 'stdio', command: 'x' } }, inputs: [{ id: 'tok', type: 'promptString' }] },
      mode: 'resilient'
    });
    expect(result.validation.valid).toBe(true);
    expect(result.package).toMatchObject({
      name: 'my-plugin',
      $schema: VALID_SCHEMA,
      skills: [{ name: 'Alpha', path: 'skills/alpha' }],
      mcpServers: [{ name: 'db', type: 'stdio', command: 'x' }],
      mcpInputs: [{ id: 'tok', type: 'promptString' }],
      extensions: {}
    });
  });

  it('omits mcpInputs when there are none and defaults mcpServers to []', () => {
    const result = buildAgentPluginPackage({ manifest, skills: [], mode: 'resilient' });
    expect(result.package?.mcpServers).toEqual([]);
    expect(result.package?.mcpInputs).toBeUndefined();
  });

  it('returns package=null on a fatal validation issue (missing name)', () => {
    const result = buildAgentPluginPackage({ manifest: { $schema: VALID_SCHEMA }, skills: [], mode: 'resilient' });
    expect(result.validation.valid).toBe(false);
    expect(result.package).toBeNull();
  });

  it('resilient mode keeps a package with a malformed name but surfaces a warning; strict rejects it', () => {
    const badName = { name: 'Bad_Name', $schema: VALID_SCHEMA };
    const resilient = buildAgentPluginPackage({ manifest: badName, skills: [], mode: 'resilient' });
    expect(resilient.validation.valid).toBe(true);
    expect(resilient.validation.warnings?.length).toBeGreaterThan(0);
    expect(resilient.package).not.toBeNull();

    const strict = buildAgentPluginPackage({ manifest: badName, skills: [], mode: 'strict' });
    expect(strict.validation.valid).toBe(false);
    expect(strict.package).toBeNull();
  });
});

describe('isSafeArchiveEntryPath (SEC-U2-2)', () => {
  it('accepts normal nested relative paths', () => {
    expect(isSafeArchiveEntryPath('skills/alpha/SKILL.md')).toBe(true);
    expect(isSafeArchiveEntryPath('deployment-manifest.yml')).toBe(true);
  });

  it('rejects traversal, absolute POSIX, and Windows-drive paths', () => {
    expect(isSafeArchiveEntryPath('../escape.txt')).toBe(false);
    expect(isSafeArchiveEntryPath('skills/../../etc/passwd')).toBe(false);
    expect(isSafeArchiveEntryPath('/etc/passwd')).toBe(false);
    expect(isSafeArchiveEntryPath('C:\\Windows\\system32')).toBe(false);
    expect(isSafeArchiveEntryPath('')).toBe(false);
  });

  it('property: never accepts a path with a `..` segment or an absolute prefix', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 1, maxLength: 6 }), (segments) => {
        const joined = segments.join('/');
        const hasTraversal = segments.some((s) => s === '..' || s.replaceAll('\\', '/').split('/').includes('..'));
        const isAbsolute = joined.replaceAll('\\', '/').startsWith('/') || /^[a-zA-Z]:/.test(joined.replaceAll('\\', '/'));
        if (hasTraversal || isAbsolute || joined.length === 0) {
          expect(isSafeArchiveEntryPath(joined)).toBe(false);
        }
      })
    );
  });

  it('property: accepts any single segment made only of safe characters', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_.-]+$/), (name) => {
        fc.pre(name.length > 0 && name !== '..');
        expect(isSafeArchiveEntryPath(`skills/x/${name}`)).toBe(true);
      })
    );
  });
});

describe('sanitizeBundleIdSegment (bundle-id synthesis)', () => {
  it('passes through a well-formed plugin name unchanged', () => {
    expect(sanitizeBundleIdSegment('my-plugin.v2')).toBe('my-plugin.v2');
  });

  it('lowercases and collapses unsafe runs, trimming separators', () => {
    expect(sanitizeBundleIdSegment('My Plugin!!Name')).toBe('my-plugin-name');
    expect(sanitizeBundleIdSegment('///weird///')).toBe('weird');
  });

  it('falls back to "plugin" for an all-unsafe name', () => {
    expect(sanitizeBundleIdSegment('!!!')).toBe('plugin');
    expect(sanitizeBundleIdSegment('')).toBe('plugin');
  });

  it('property: output is non-empty, lowercase, and never contains a path separator or traversal', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const out = sanitizeBundleIdSegment(name);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toBe(out.toLowerCase());
        expect(out.includes('/')).toBe(false);
        expect(out.includes('\\')).toBe(false);
        expect(out.includes('..')).toBe(false);
        // The synthesized segment is always itself a safe archive path.
        expect(isSafeArchiveEntryPath(out)).toBe(true);
      })
    );
  });

  it('property: synthesis is deterministic (same input → same output)', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        expect(sanitizeBundleIdSegment(name)).toBe(sanitizeBundleIdSegment(name));
      })
    );
  });
});
