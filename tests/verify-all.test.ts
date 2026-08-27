import { describe, expect, it } from 'vitest';
// Imported directly rather than through a wrapper: this test is the script's
// contract, and a shim between them could drift from what actually runs.
import {
  gateIdsFor,
  judgeCoverage,
  phasesFor,
  readSuiteReport,
  renderSummary
} from '../scripts/verify-all.mjs';

/**
 * The aggregator is the single point of failure for every check in the
 * repository: if it silently drops a gate, everything downstream of it reports
 * green while nothing is being verified. So it gets the treatment it gives
 * everything else.
 */

interface GateResult {
  id: string;
  ok: boolean;
  duration_ms: number;
}

function successResult(gates: GateResult[]) {
  return {
    ok: true,
    command: 'verify' as const,
    generated_at: '2026-08-25T00:00:00.000Z',
    form: 'fast' as const,
    data: {
      duration_ms: 41_000,
      totals: {
        gates: gates.length,
        passed: gates.length,
        failed: 0,
        tests: 1403,
        skipped_tests: 0,
        skip_reasons: {},
        coverage_lines: 71.2
      },
      gates
    }
  };
}

function failureResult(excerptLines: number) {
  const gates = [
    { id: 'format', ok: true, duration_ms: 900 },
    { id: 'lint', ok: true, duration_ms: 5_512 },
    { id: 'typecheck:tests', ok: false, duration_ms: 22_000 }
  ];
  return {
    ok: false,
    command: 'verify' as const,
    generated_at: '2026-08-25T00:00:00.000Z',
    form: 'fast' as const,
    error: 'typecheck:tests',
    data: {
      duration_ms: 28_412,
      totals: {
        gates: gates.length,
        passed: 2,
        failed: 1,
        tests: 0,
        skipped_tests: 0,
        skip_reasons: {},
        coverage_lines: null
      },
      gates,
      failure: {
        gate: 'typecheck:tests',
        subject: 'tests/queue.test.ts(88,7): error TS2345: Argument of type …',
        excerpt: Array.from({ length: excerptLines }, (_unused, index) => `line ${index}`)
      }
    }
  };
}

describe('gate lists', () => {
  it('gives every gate id to exactly one form', () => {
    const fast = gateIdsFor('fast');
    const release = gateIdsFor('release');
    // The release form is the fast form plus more phases, so an id in both is
    // not a duplicate run — it is the release result silently reporting a
    // narrower set than it reads.
    expect(new Set(fast).size).toBe(fast.length);
    expect(new Set(release).size).toBe(release.length);
    for (const id of fast) expect(release).toContain(id);
  });

  it('runs more phases in the release form than the fast one', () => {
    expect(phasesFor('release').length).toBeGreaterThan(phasesFor('fast').length);
  });

  it('includes prerequisites when CI asks for an isolated group', () => {
    // Each job starts from a clean checkout. Shared output cannot leak from the
    // static job, and the browser checks cannot borrow a build from another
    // runner, so grouped invocations carry only their required prerequisites.
    expect(phasesFor('fast', 'suite')).toEqual(['seed', 'suite']);
    expect(phasesFor('release', 'build')).toEqual(['seed', 'build']);
    expect(phasesFor('release', 'e2e')).toEqual(['seed', 'build', 'e2e']);
  });
});

describe('output budgets', () => {
  it('keeps success inside twenty lines', () => {
    const gates = Array.from({ length: 6 }, (_unused, index) => ({
      id: `gate-${index}`,
      ok: true,
      duration_ms: 1_000
    }));
    expect(renderSummary(successResult(gates)).length).toBeLessThanOrEqual(20);
  });

  it('collapses the gate block rather than breaking the cap', () => {
    // A future gate list long enough to overflow must not quietly widen the
    // budget the contract states.
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      id: `gate-${index}`,
      ok: true,
      duration_ms: 1_000
    }));
    const lines = renderSummary(successResult(many));
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.some(line => /all 40 gates/u.test(line))).toBe(true);
  });

  it('keeps failure inside a hundred lines however much the gate said', () => {
    expect(renderSummary(failureResult(5_000)).length).toBeLessThanOrEqual(100);
  });

  it('names the failing gate and its subject in the first ten lines', () => {
    const lines = renderSummary(failureResult(500));
    const head = lines.slice(0, 10).join('\n');
    expect(head).toContain('typecheck:tests');
    // Verbatim: the aggregator truncates what a gate said, it never rewrites
    // it, or "sufficient to act on without re-running" stops being true.
    expect(head).toContain('error TS2345');
  });

  it('keeps the end of a long excerpt, not the beginning', () => {
    const lines = renderSummary(failureResult(500));
    // Compilers and runners put the summary last; a head-truncated log is the
    // one part guaranteed not to name the failure.
    expect(lines.join('\n')).toContain('line 499');
  });
});

describe('skip accounting', () => {
  it('histograms requirement markers from the suite title', () => {
    const report = readSuiteReport({
      testResults: [
        {
          assertionResults: [
            { status: 'passed', title: 'encodes', ancestorTitles: ['encoder'] },
            {
              status: 'pending',
              title: 'transcodes',
              ancestorTitles: ['real encoder fidelity [needs: ffmpeg,ffprobe]']
            }
          ]
        }
      ]
    });
    expect(report.tests).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.skipReasons).toEqual({ ffmpeg: 1, ffprobe: 1 });
    expect(report.unexplained).toEqual([]);
    expect(report.failed).toEqual([]);
  });

  it('reports a skip that carries no reason', () => {
    const report = readSuiteReport({
      testResults: [
        {
          assertionResults: [{ status: 'skipped', title: 'flaky one', ancestorTitles: ['queue'] }]
        }
      ]
    });
    // SC-007 in one line: an unexplained skip is indistinguishable from a gap,
    // so it is treated as one.
    expect(report.unexplained).toEqual(['queue flaky one']);
  });

  it('keeps exact failed test titles for bounded CI diagnostics', () => {
    const report = readSuiteReport({
      testResults: [
        {
          assertionResults: [
            {
              status: 'failed',
              title: 'resumes before termination',
              ancestorTitles: ['power governor', 'hold protocol'],
              failureMessages: ['expected undefined to be SIGCONT\nstack follows']
            }
          ]
        }
      ]
    });
    expect(report.failed).toEqual([
      'power governor > hold protocol > resumes before termination — expected undefined to be SIGCONT'
    ]);
  });
});

describe('the coverage verdict', () => {
  /** judgeCoverage returns null only with no summary; every case below passes one. */
  function expectVerdict(input: Parameters<typeof judgeCoverage>[0]) {
    const verdict = judgeCoverage(input);
    if (!verdict) throw new Error('expected a coverage verdict');
    return verdict;
  }

  const summary = {
    total: { lines: { pct: 76 } },
    'apps/agent/src/queue/queue.ts': { lines: { pct: 90 } },
    'apps/web/src/App.tsx': { lines: { pct: 60 } }
  };

  it('fails a critical module below its floor even when the global rose', () => {
    // FR-018 in one case. A global average is exactly the instrument that lets
    // an uncovered state module hide: it is one file among hundreds, and the
    // average has no opinion about which ones matter.
    const verdict = expectVerdict({
      summary,
      baseline: { total_lines: 70, files: {} },
      critical: { modules: { 'apps/agent/src/queue/queue.ts': 95 } }
    });
    expect(verdict.failures.some((line: string) => line.includes('queue.ts'))).toBe(true);
  });

  it('judges a report whose paths are absolute the same as one that is relative', () => {
    // The provider has emitted both forms. Compared as written, an absolute
    // summary makes every floor read "not measured" and every baselined file
    // read "no longer measured" — a wall of failures describing nothing about
    // coverage, and the shape that hides a real fall inside it.
    const absolute = {
      total: { lines: { pct: 80 } },
      [`${process.cwd()}/apps/agent/src/queue/queue.ts`]: { lines: { pct: 90 } }
    };
    const verdict = expectVerdict({
      summary: absolute,
      baseline: { total_lines: 70, files: { 'apps/agent/src/queue/queue.ts': 88 } },
      critical: { modules: { 'apps/agent/src/queue/queue.ts': 85 } }
    });

    expect(verdict.failures).toEqual([]);
    expect(verdict.files['apps/agent/src/queue/queue.ts']).toBe(90);
  });

  it('fails a critical module that stopped being measured', () => {
    const verdict = expectVerdict({
      summary,
      baseline: null,
      critical: { modules: { 'apps/agent/src/queue/gone.ts': 50 } }
    });
    expect(verdict.failures.some((line: string) => line.includes('not measured'))).toBe(true);
  });

  it('fails a global that fell', () => {
    const verdict = expectVerdict({
      summary,
      baseline: { total_lines: 80, files: {} },
      critical: { modules: {} }
    });
    expect(verdict.failures.some((line: string) => line.includes('global'))).toBe(true);
  });

  it('tolerates a file moving by a fraction', () => {
    // V8 coverage shifts slightly when unrelated code changes shape, and a
    // ratchet that fires on noise is one people learn to route around.
    const verdict = expectVerdict({
      summary,
      baseline: { total_lines: 70, files: { 'apps/web/src/App.tsx': 61 } },
      critical: { modules: {} }
    });
    expect(verdict.failures).toEqual([]);
  });

  it('fails a baselined file that vanished', () => {
    const verdict = expectVerdict({
      summary,
      baseline: { total_lines: 70, files: { 'apps/web/src/Removed.tsx': 50 } },
      critical: { modules: {} }
    });
    expect(verdict.failures.some((line: string) => line.includes('no longer measured'))).toBe(true);
  });

  it('says nothing at all when coverage was not measured', () => {
    // The fast form does not measure; treating that as a fall to zero would
    // make the cheap command fail for doing exactly what it promises.
    expect(judgeCoverage({ summary: null, baseline: null, critical: null })).toBeNull();
  });
});
