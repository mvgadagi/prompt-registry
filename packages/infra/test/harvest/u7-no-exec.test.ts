/**
 * SEC-U7-4 (no-exec, accepted-risk-at-parity): U7 records/synthesizes only —
 * it maps namespace dirs to the existing `agent`/`hook` PrimitiveKind and
 * bakes them into the bundle. Execution happens at the consuming harness, not
 * here. This test statically asserts that the U7 code path carries NO
 * process/exec construct (`child_process`, `spawn`, `exec`/`execSync`, `fork`).
 * @module test/harvest/u7-no-exec
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';

const SRC = path.resolve(__dirname, '../../src');

/** The three source files that make up the U7 (agents/hooks namespace) path. */
const U7_PATH_FILES = [
  'harvest/agent-plugin-manifest.ts',
  'adapters/agent-plugins-adapter.ts',
  'adapters/local-agent-plugins-adapter.ts'
];

/**
 * Forbidden process/exec constructs (SEC-U7-4). The `(?<![\w.])` lookbehind
 * keeps legitimate method calls like `RegExp.prototype.exec()` from matching
 * — only bare `exec(`/`spawn(`/`fork(` (the `child_process` free functions)
 * and any `child_process` import are rejected.
 */
const FORBIDDEN = [
  /\bchild_process\b/,
  /\bnode:child_process\b/,
  /(?<![\w.])spawn(?:Sync)?\s*\(/,
  /(?<![\w.])exec(?:Sync|File|FileSync)?\s*\(/,
  /(?<![\w.])fork\s*\(/
];

describe('SEC-U7-4 — no process/exec construct in the U7 path', () => {
  for (const relPath of U7_PATH_FILES) {
    it(`${relPath} contains no child_process/spawn/exec/fork construct`, () => {
      const source = fs.readFileSync(path.join(SRC, relPath), 'utf8');
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(source), `${relPath} must not use ${pattern}`).toBe(false);
      }
    });
  }
});
