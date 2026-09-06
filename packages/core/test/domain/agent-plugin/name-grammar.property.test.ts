/**
 * Property tests (fast-check) for the Agent Plugins name grammar (R1) and
 * validator determinism (R5), per NFR-4 and SEC-U1-4.
 *
 * The name grammar is checked in linear time (no catastrophic backtracking);
 * these tests feed generated/adversarial inputs and assert bounded, correct
 * accept/reject behaviour and that the validator is a pure function.
 */
import fc from 'fast-check';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  AGENT_PLUGIN_NAME_MAX_LENGTH,
  validateAgentPluginManifest,
  validateAgentPluginName,
} from '../../../src/domain/agent-plugin/validate';

/**
 * Reference oracle for the R1 grammar, independent of the implementation.
 * @param name
 */
function isWellFormedName(name: string): boolean {
  if (name.length === 0 || name.length > AGENT_PLUGIN_NAME_MAX_LENGTH) {
    return false;
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    return false;
  }
  return !(name.includes('--') || name.includes('..'));
}

describe('validateAgentPluginName — property: acceptance matches the R1 oracle', () => {
  it('agrees with the reference oracle on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const accepted = validateAgentPluginName(name) === null;
        expect(accepted).toBe(isWellFormedName(name));
      }),
      { numRuns: 1000 }
    );
  });

  it('accepts names generated from the allowed grammar', () => {
    const alnum = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const middle = `${alnum}.-`;
    const wellFormed = fc
      .tuple(
        fc.constantFrom(...alnum.split('')),
        fc.stringOf(fc.constantFrom(...middle.split('')), { maxLength: 30 }),
        fc.constantFrom(...alnum.split(''))
      )
      .map(([first, mid, last]) => `${first}${mid}${last}`)
      .filter((name) => !name.includes('--') && !name.includes('..'));

    fc.assert(
      fc.property(wellFormed, (name) => {
        expect(validateAgentPluginName(name)).toBeNull();
      })
    );
  });
});

describe('validateAgentPluginName — property: ReDoS-safe / bounded evaluation (SEC-U1-4)', () => {
  it('terminates quickly on adversarial repeated-separator inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.constantFrom('-', '.', 'a-', 'a.', '-.'),
        (count, unit) => {
          const adversarial = unit.repeat(count);
          const start = Date.now();
          validateAgentPluginName(adversarial);
          // Linear scan: comfortably under 50ms even for large inputs.
          expect(Date.now() - start).toBeLessThan(50);
        }
      ),
      { numRuns: 50 }
    );
  });
});

describe('validateAgentPluginManifest — property: determinism (R5)', () => {
  it('returns an identical result for the same input across modes', () => {
    const arbManifest = fc.record(
      {
        $schema: fc.oneof(fc.string(), fc.integer()),
        name: fc.oneof(fc.string(), fc.integer()),
        version: fc.string(),
        bogus: fc.option(fc.string(), { nil: undefined })
      },
      { requiredKeys: [] }
    );

    fc.assert(
      fc.property(
        arbManifest,
        fc.constantFrom('strict', 'resilient'),
        (manifest, mode) => {
          const a = validateAgentPluginManifest(manifest, mode);
          const b = validateAgentPluginManifest(manifest, mode);
          expect(a).toEqual(b);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('never reports errors when valid=true (invariant)', () => {
    const arbManifest = fc.record(
      {
        $schema: fc.oneof(fc.string(), fc.constant(undefined)),
        name: fc.oneof(fc.string(), fc.constant(undefined)),
        extra: fc.option(fc.string(), { nil: undefined })
      },
      { requiredKeys: [] }
    );

    fc.assert(
      fc.property(
        arbManifest,
        fc.constantFrom('strict', 'resilient'),
        (manifest, mode) => {
          const result = validateAgentPluginManifest(manifest, mode);
          if (result.valid) {
            expect(result.errors).toEqual([]);
          } else {
            expect(result.errors.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});
