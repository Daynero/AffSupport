import { describe, expect, it } from 'vitest';
import { reconcileEffect } from '../scripts/lib/release/recovery.mjs';
import { reconcileGitHub } from '../scripts/lib/release/adapters/github.mjs';

describe('external effect ambiguity', () => {
  it.each(['dispatch', 'upload', 'push', 'deploy', 'migration'])(
    'blocks ambiguous %s outcomes',
    kind => {
      expect(reconcileEffect({ kind }, 'ambiguous')).toMatchObject({
        state: 'blocked',
        retry: false
      });
    }
  );
  it('only permits a retry after proven absence', () => {
    expect(reconcileEffect({ kind: 'publish' }, 'provenAbsent')).toEqual({
      state: 'absent',
      retry: true
    });
    expect(reconcileEffect({ kind: 'publish' }, 'conflicting')).toMatchObject({
      code: 'EFFECT_AMBIGUOUS'
    });
  });
  it('matches a remote effect only by exact correlation evidence', () => {
    expect(reconcileGitHub({ runId: '1', sha: 'a' }, { runId: '1', sha: 'a' })).toEqual({
      state: 'matching'
    });
    expect(reconcileGitHub({ runId: '1', sha: 'a' }, { runId: '2', sha: 'a' })).toMatchObject({
      state: 'conflicting'
    });
  });
});
