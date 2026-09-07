import {
  AGENT_PLUGINS_EXTENSION_NS,
} from '@ai-primitives-hub/core';
import fc from 'fast-check';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  buildAgentPluginPackage,
  buildNamespaceEntries,
  foldMcpJson,
  isSafeArchiveEntryPath,
  mcpServerDefsFromRecord,
  mcpServersRecordFromDefs,
  NAMESPACE_GROUPS,
  type NamespaceFileInput,
  namespaceGroupDir,
  namespacePromptDescriptors,
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

// ---------------------------------------------------------------------------
// U7 — reverse-domain namespace (agents/hooks) parser extension
// ---------------------------------------------------------------------------

describe('namespaceGroupDir + NAMESPACE_GROUPS (U7)', () => {
  it('exposes exactly the agents/hooks subgroups under the reverse-domain namespace', () => {
    expect([...NAMESPACE_GROUPS]).toEqual(['agents', 'hooks']);
    expect(namespaceGroupDir('agents')).toBe(`${AGENT_PLUGINS_EXTENSION_NS}/agents`);
    expect(namespaceGroupDir('hooks')).toBe(`${AGENT_PLUGINS_EXTENSION_NS}/hooks`);
  });

  it('pins the namespace constant to the Amadeus reverse-domain string (reused from core, not redefined)', () => {
    expect(AGENT_PLUGINS_EXTENSION_NS).toBe('com.amadeus.aiprimitiveshub');
  });
});

describe('buildNamespaceEntries (U7)', () => {
  it('maps agents/hooks dirs to the EXISTING agent/hook PrimitiveKind (no new kind) and prefixes the namespace path', () => {
    const entries = buildNamespaceEntries([
      { group: 'agents', relativePath: 'reviewer.md', contents: '' },
      { group: 'hooks', relativePath: 'on-save.md', contents: '' }
    ]);
    expect(entries).toEqual([
      { kind: 'agent', bundlePath: `${AGENT_PLUGINS_EXTENSION_NS}/agents/reviewer.md` },
      { kind: 'hook', bundlePath: `${AGENT_PLUGINS_EXTENSION_NS}/hooks/on-save.md` }
    ]);
  });

  it('skips a file under an unknown subgroup (only agents/hooks live under the namespace)', () => {
    expect(buildNamespaceEntries([{ group: 'skills', relativePath: 'x.md', contents: '' }])).toEqual([]);
    expect(buildNamespaceEntries([{ group: 'nonsense', relativePath: 'x.md', contents: '' }])).toEqual([]);
  });

  it('SEC-U7-1: skips a malformed .json entry (skip-invalid) and keeps a valid one (keep-valid)', () => {
    const entries = buildNamespaceEntries([
      { group: 'hooks', relativePath: 'hooks.json', contents: '{ not json' },
      { group: 'hooks', relativePath: 'valid.json', contents: JSON.stringify({ hooks: [] }) },
      { group: 'agents', relativePath: 'agent.md', contents: '# not parsed (non-JSON)' }
    ]);
    expect(entries.map((entry) => entry.bundlePath)).toEqual([
      `${AGENT_PLUGINS_EXTENSION_NS}/hooks/valid.json`,
      `${AGENT_PLUGINS_EXTENSION_NS}/agents/agent.md`
    ]);
  });

  it('strips a leading ./ from the relative path', () => {
    const [entry] = buildNamespaceEntries([{ group: 'agents', relativePath: './nested/a.md', contents: '' }]);
    expect(entry.bundlePath).toBe(`${AGENT_PLUGINS_EXTENSION_NS}/agents/nested/a.md`);
  });

  it('property (SEC-U7-1): a malformed .json entry is never kept; a valid .json is always kept', () => {
    fc.assert(
      fc.property(fc.constantFrom('agents', 'hooks'), fc.string(), (group, garbage) => {
        // A deliberately-malformed JSON blob (leading brace, no close).
        const malformed = buildNamespaceEntries([{ group, relativePath: 'x.json', contents: `{${garbage}` }]);
        let parses = true;
        try {
          const parsed: unknown = JSON.parse(`{${garbage}`);
          parses = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch {
          parses = false;
        }
        expect(malformed.length).toBe(parses ? 1 : 0);
      }),
      { numRuns: 60 }
    );
  });
});

describe('namespacePromptDescriptors (U7 synthesis)', () => {
  it('derives a safe id/name/type from each entry, using the existing kind as the manifest type', () => {
    const descriptors = namespacePromptDescriptors([
      { kind: 'agent', bundlePath: `${AGENT_PLUGINS_EXTENSION_NS}/agents/Code Reviewer.md` },
      { kind: 'hook', bundlePath: `${AGENT_PLUGINS_EXTENSION_NS}/hooks/on-save.json` }
    ]);
    expect(descriptors).toEqual([
      {
        id: 'agent-code-reviewer',
        name: 'Code Reviewer',
        description: `agent carried under ${AGENT_PLUGINS_EXTENSION_NS}`,
        file: `${AGENT_PLUGINS_EXTENSION_NS}/agents/Code Reviewer.md`,
        type: 'agent'
      },
      {
        id: 'hook-on-save',
        name: 'on-save',
        description: `hook carried under ${AGENT_PLUGINS_EXTENSION_NS}`,
        file: `${AGENT_PLUGINS_EXTENSION_NS}/hooks/on-save.json`,
        type: 'hook'
      }
    ]);
  });

  it('property: every synthesized id is a safe archive segment (no separator/traversal)', () => {
    fc.assert(
      fc.property(fc.constantFrom<'agent' | 'hook'>('agent', 'hook'), fc.string(), (kind, stem) => {
        const [descriptor] = namespacePromptDescriptors([
          { kind, bundlePath: `${AGENT_PLUGINS_EXTENSION_NS}/${kind}s/${stem}.md` }
        ]);
        expect(isSafeArchiveEntryPath(descriptor.id)).toBe(true);
        expect(descriptor.type).toBe(kind);
      }),
      { numRuns: 60 }
    );
  });
});

describe('buildAgentPluginPackage — extensions population (U7)', () => {
  const manifest = { name: 'my-plugin', $schema: VALID_SCHEMA };

  it('populates extensions[namespace] with agents/hooks path lists when namespace entries are present', () => {
    const namespaceEntries = buildNamespaceEntries([
      { group: 'agents', relativePath: 'a.md', contents: '' },
      { group: 'hooks', relativePath: 'h.md', contents: '' }
    ]);
    const { package: pkg } = buildAgentPluginPackage({ manifest, skills: [], namespaceEntries, mode: 'resilient' });
    expect(pkg?.extensions).toEqual({
      [AGENT_PLUGINS_EXTENSION_NS]: {
        agents: [`${AGENT_PLUGINS_EXTENSION_NS}/agents/a.md`],
        hooks: [`${AGENT_PLUGINS_EXTENSION_NS}/hooks/h.md`]
      }
    });
  });

  it('keeps extensions = {} when no namespace entries are supplied (pre-U7 shape preserved)', () => {
    expect(buildAgentPluginPackage({ manifest, skills: [], mode: 'resilient' }).package?.extensions).toEqual({});
    expect(buildAgentPluginPackage({ manifest, skills: [], namespaceEntries: [], mode: 'resilient' }).package?.extensions).toEqual({});
  });

  it('drops the whole package (extensions included) when plugin.json is fatally invalid (parity with skills path)', () => {
    const namespaceEntries: NamespaceFileInput[] = [{ group: 'agents', relativePath: 'a.md', contents: '' }];
    const result = buildAgentPluginPackage({
      manifest: { $schema: VALID_SCHEMA },
      skills: [],
      namespaceEntries: buildNamespaceEntries(namespaceEntries),
      mode: 'resilient'
    });
    expect(result.validation.valid).toBe(false);
    expect(result.package).toBeNull();
  });
});
