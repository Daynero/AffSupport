import { describe, expect, it } from 'vitest';
import { bundlesToKeep, parseHistory, selectRollbackTarget } from '../scripts/lib/web-rollback.mjs';

const entry = (sourceSha: string, outputDigest: string, deployedAt: string) => ({
  sourceSha,
  outputDigest,
  deployedAt,
  binding: { bindingId: 'production' }
});

const history = [
  entry('a'.repeat(40), 'd1', '2026-09-01T10:00:00.000Z'),
  entry('b'.repeat(40), 'd2', '2026-09-05T10:00:00.000Z'),
  entry('c'.repeat(40), 'd3', '2026-09-12T10:00:00.000Z')
];

describe('choosing what to roll the site back to', () => {
  it('reads a history file and ignores anything that is not a deployment', () => {
    const text = `${JSON.stringify(history[0])}\n\n${JSON.stringify({ note: 'not a deployment' })}\n${JSON.stringify(history[1])}\n`;
    expect(parseHistory(text)).toEqual([history[0], history[1]]);
  });

  it('picks the bundle that was serving before the current one', () => {
    const { target, current, problems } = selectRollbackTarget(history, {
      archived: ['d1', 'd2', 'd3']
    });
    expect(problems).toEqual([]);
    expect(current?.outputDigest).toBe('d3');
    expect(target?.outputDigest).toBe('d2');
  });

  it('skips a redeploy of identical bytes, which would roll nothing back', () => {
    // A redeploy of the same bundle gets a new deployment id and changes
    // nothing; treating it as "the previous release" would produce a rollback
    // that appears to happen and does not.
    const redeployed = [...history, entry('d'.repeat(40), 'd3', '2026-09-12T11:00:00.000Z')];
    expect(
      selectRollbackTarget(redeployed, { archived: ['d1', 'd2', 'd3'] }).target?.outputDigest
    ).toBe('d2');
  });

  it('refuses when the earlier bundle is no longer on disk', () => {
    // Pruned, or moved to another machine. Rebuilding instead would ship bytes
    // nobody has served, so refusing is the honest answer.
    expect(selectRollbackTarget(history, { archived: ['d3'] })).toEqual({
      target: null,
      current: history[2],
      problems: ['no earlier bundle is still archived, so there is nothing to roll back to']
    });
  });

  it('refuses to roll back to nothing at all', () => {
    expect(selectRollbackTarget([], { archived: [] }).problems).toEqual([
      'nothing has been deployed from this machine, so there is nothing to roll back to'
    ]);
  });

  it('accepts a named target by either identity, and refuses an unknown one', () => {
    expect(
      selectRollbackTarget(history, { to: 'a'.repeat(8), archived: ['d1', 'd3'] }).target
        ?.outputDigest
    ).toBe('d1');
    expect(
      selectRollbackTarget(history, { to: 'd1', archived: ['d1', 'd3'] }).target?.outputDigest
    ).toBe('d1');
    expect(selectRollbackTarget(history, { to: 'nope', archived: ['d1', 'd3'] }).problems).toEqual([
      'no deployment matches nope'
    ]);
  });

  it('refuses a named target that is already what is deployed', () => {
    expect(selectRollbackTarget(history, { to: 'd3', archived: ['d1', 'd3'] }).problems).toEqual([
      'd3 is what is deployed now'
    ]);
  });

  it('refuses a named target whose bytes were pruned', () => {
    expect(selectRollbackTarget(history, { to: 'd1', archived: ['d2', 'd3'] }).problems).toEqual([
      'the bundle for d1 is no longer archived, so its exact bytes cannot be redeployed'
    ]);
  });

  it('keeps the newest distinct bundles and counts a redeploy once', () => {
    const redeployed = [...history, entry('d'.repeat(40), 'd3', '2026-09-12T11:00:00.000Z')];
    expect(bundlesToKeep(redeployed, 2)).toEqual(['d3', 'd2']);
    expect(bundlesToKeep(history, 5)).toEqual(['d3', 'd2', 'd1']);
  });
});
