import { describe, expect, it } from 'vitest';
import { resolveIntent } from '../scripts/lib/release/intent.mjs';
import { initialRun, transition } from '../scripts/lib/release/state.mjs';
import { sandboxIntent } from './support/release-runner/fixtures';

describe('release runner contract boundaries', () => {
  it('accepts a complete sandbox intent and rejects unknown or unsafe input', () => {
    expect(resolveIntent(sandboxIntent)).toMatchObject({ targetKind: 'sandbox', version: '1.1.1' });
    expect(() => resolveIntent({ ...sandboxIntent, command: 'rm -rf /' })).toThrow(
      'Unknown intent field'
    );
    expect(() => resolveIntent({ ...sandboxIntent, targetId: 'P' })).toThrow('targetId');
    expect(() => resolveIntent({ ...sandboxIntent, bump: 'patch' })).toThrow('Exactly one');
  });

  it('does not treat accepted work as completed and rejects impossible transitions', () => {
    const draft = initialRun(sandboxIntent);
    const preflight = transition(draft, 'preflight');
    expect(preflight.state).toBe('preflight');
    expect(preflight.state).not.toBe('completed');
    expect(() => transition(draft, 'completed')).toThrow('Invalid release transition');
  });
});
