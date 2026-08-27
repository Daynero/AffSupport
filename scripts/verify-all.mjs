#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhase } from './lib/gate.mjs';

/**
 * One command, one verdict.
 *
 * Ten hand-typed commands in two documents was not a checklist, it was a memory
 * test — and the thing about a memory test is that the step you forget is the
 * one you never learn you forgot. This runs them all, reports machine-readably,
 * and says almost nothing when everything is fine.
 *
 * **The two forms differ only in which gates run.** Never in how a result is
 * reported, never in how a failure is presented. That is what makes the promise
 * structural rather than aspirational: there is one code path here, and `--form`
 * chooses a list.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULT_FILE = path.join(root, 'verification-result.json');
const SUITE_REPORT_FILE = path.join(root, 'verification-suite.json');
const COVERAGE_SUMMARY_FILE = path.join(root, 'coverage/coverage-summary.json');
const COVERAGE_BASELINE_FILE = path.join(root, 'coverage-baseline.json');
const COVERAGE_CRITICAL_FILE = path.join(root, 'coverage-critical.json');

/**
 * How far a single file may fall before the ratchet objects.
 *
 * Not zero: V8 coverage moves by fractions when unrelated code changes shape,
 * and a ratchet that fires on noise is one people learn to bypass.
 */
const FILE_FALL_TOLERANCE_POINTS = 2;

/** Success output cap, from the contract. One header, gates, blank, two totals. */
const SUCCESS_LINE_CAP = 20;
/** Failure output cap. Line 1 names the gate, line 2 the subject. */
const FAILURE_LINE_CAP = 100;
/** How many of a failing gate's own lines may be shown, inside that cap. */
const EXCERPT_LINE_CAP = 88;
/** The subject must appear this early, so it is visible without scrolling. */
const SUBJECT_WITHIN_LINES = 10;

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');

/** A gate that runs an npm script, which is how every existing check is spelled. */
function script(id, name, timeoutMs, extra = {}) {
  return {
    id,
    command: npm,
    args: ['run', '--silent', name],
    timeoutMs,
    shell: process.platform === 'win32',
    ...extra
  };
}

/**
 * The gate lists.
 *
 * Every id appears in exactly one form's list — asserted by a test, because an
 * id in both would make the release form's result silently narrower than it
 * reads. `release` is `fast` plus the phases fast does not run.
 */
const PHASES = {
  seed: {
    group: 'static',
    exclusive: false,
    gates: () => [
      {
        id: 'build:shared',
        command: npm,
        args: ['run', '--silent', 'build', '-w', '@video-compressor/shared'],
        shell: process.platform === 'win32',
        timeoutMs: 180_000
      }
    ]
  },
  static: {
    group: 'static',
    exclusive: false,
    gates: () => [
      script('format', 'format:check', 180_000),
      script('lint', 'lint', 300_000),
      script('typecheck:projects', 'typecheck:projects', 600_000),
      script('typecheck:tests', 'typecheck:tests', 600_000),
      script('typecheck:scripts', 'typecheck:scripts', 300_000),
      {
        id: 'styles',
        command: 'node',
        args: [path.join(root, 'scripts/verify-styles.mjs')],
        timeoutMs: 60_000
      },
      {
        id: 'i18n',
        command: 'node',
        args: [path.join(root, 'scripts/verify-i18n.mjs')],
        timeoutMs: 60_000
      },
      {
        id: 'csp',
        command: 'node',
        args: [path.join(root, 'scripts/generate-csp-headers.mjs'), '--check'],
        timeoutMs: 60_000
      },
      {
        id: 'audit',
        command: 'node',
        args: [path.join(root, 'scripts/audit-dependencies.mjs')],
        timeoutMs: 300_000
      }
    ]
  },
  suite: {
    group: 'suite',
    // A17: the suite rebuilds the shared package's committed output and
    // rewrites a tracked migration, which any concurrent phase would be
    // reading. It also saturates every core on its own, so overlapping it buys
    // nothing even where it would be safe.
    exclusive: true,
    gates: form => [
      {
        id: 'suite',
        // Spawning npx.cmd directly with shell:false fails with EINVAL on the
        // Windows runner. Vitest is already an installed dependency, so invoke
        // its portable Node entry point without a command-shell intermediary.
        command: process.execPath,
        args: [
          vitest,
          'run',
          '--project=unit',
          '--reporter=dot',
          '--reporter=json',
          `--outputFile.json=${SUITE_REPORT_FILE}`,
          '--silent=passed-only',
          ...(form === 'release' ? ['--coverage'] : [])
        ],
        timeoutMs: 1_800_000
      }
    ]
  },
  build: {
    group: 'build',
    exclusive: false,
    forms: ['release'],
    gates: () => [
      script('build:web', 'build:web', 900_000),
      {
        id: 'build:agent',
        command: npm,
        args: ['run', '--silent', 'build', '-w', '@video-compressor/agent'],
        shell: process.platform === 'win32',
        timeoutMs: 600_000
      },
      {
        id: 'contract:release',
        command: 'node',
        args: [path.join(root, 'scripts/verify-release.mjs')],
        timeoutMs: 300_000
      },
      {
        id: 'contract:web-env',
        command: 'node',
        args: [path.join(root, 'scripts/verify-web-env.mjs')],
        timeoutMs: 120_000
      },
      script('contract:team', 'generate:team-contract:check', 300_000)
    ]
  },
  e2e: {
    group: 'e2e',
    // Out of process, real binaries, real ports: two of these at once would
    // contend for the same fixed agent port.
    exclusive: true,
    forms: ['release'],
    gates: () => [
      script('database', 'test:db', 900_000),
      {
        // Same reason as the policy smoke test: it needs a built site and a
        // real browser.
        id: 'a11y',
        command: 'node',
        args: [path.join(root, 'scripts/verify-a11y.mjs')],
        timeoutMs: 600_000
      },
      {
        // The policy smoke test drives a real browser against the built site,
        // so it belongs to the phase that runs after the builds rather than to
        // the ordinary suite.
        id: 'csp:browser',
        command: process.execPath,
        args: [vitest, 'run', 'tests/csp-smoke.test.ts', '--reporter=dot'],
        timeoutMs: 600_000
      }
    ]
  }
};

const PHASE_ORDER = ['seed', 'static', 'suite', 'build', 'e2e'];
/** @type {Record<string, string[]>} */
const GROUP_PHASES = {
  static: ['seed', 'static'],
  suite: ['seed', 'suite'],
  build: ['seed', 'build'],
  // The browser checks read the built site and real Agent binaries.
  e2e: ['seed', 'build', 'e2e']
};

function parseArgs(argv) {
  const args = { form: null, json: false, gates: null, updateCoverageBaseline: false };
  for (const entry of argv) {
    if (entry.startsWith('--form=')) args.form = entry.slice('--form='.length);
    else if (entry === '--json') args.json = true;
    else if (entry.startsWith('--gates=')) args.gates = entry.slice('--gates='.length);
    else if (entry === '--update-coverage-baseline') args.updateCoverageBaseline = true;
  }
  return args;
}

/**
 * The phases this invocation will run, in order.
 *
 * @param {'fast'|'release'} form
 * @param {string|null} [group] one named phase group, as the CI jobs pass
 * @returns {string[]}
 */
export function phasesFor(form, group = null) {
  const selected = group ? (GROUP_PHASES[group] ?? []) : PHASE_ORDER;
  return PHASE_ORDER.filter(name => {
    if (!selected.includes(name)) return false;
    const phase = PHASES[name];
    if (phase.forms && !phase.forms.includes(form)) return false;
    return true;
  });
}

/**
 * Every gate id a form would run. Exported so the self-test can compare lists.
 *
 * @param {'fast'|'release'} form
 * @returns {string[]}
 */
export function gateIdsFor(form) {
  return phasesFor(form).flatMap(name => PHASES[name].gates(form).map(gate => gate.id));
}

function envelope({ ok, form, startedAt, gates, failure, suite }) {
  const totals = {
    gates: gates.length,
    passed: gates.filter(gate => gate.ok).length,
    failed: gates.filter(gate => !gate.ok).length,
    tests: suite?.tests ?? 0,
    skipped_tests: suite?.skipped ?? 0,
    skip_reasons: suite?.skipReasons ?? {},
    coverage_lines: suite?.coverageLines ?? null
  };
  return {
    ok,
    command: 'verify',
    generated_at: new Date().toISOString(),
    form,
    ...(ok ? {} : { error: failure?.gate }),
    data: {
      duration_ms: Date.now() - startedAt,
      totals,
      gates: gates.map(gate => ({
        id: gate.id,
        ok: gate.ok,
        duration_ms: gate.duration_ms,
        ...(gate.skipped_reason ? { skipped_reason: gate.skipped_reason } : {})
      })),
      ...(failure ? { failure } : {})
    }
  };
}

/**
 * The human summary, built to a cap rather than trimmed to one.
 *
 * The cap is asserted below, not hoped for: a future gate list that would push
 * success past twenty lines collapses the per-gate block into one line instead
 * of quietly breaking the budget the contract states.
 */
export function renderSummary(result) {
  const { form, data } = result;
  if (result.ok) {
    const seconds = (data.duration_ms / 1000).toFixed(0);
    const header = `verify (${form}): ${data.totals.passed}/${data.totals.gates} gates passed in ${seconds}s`;
    const gateLines = data.gates.map(
      gate => `  ✓ ${gate.id} ${(gate.duration_ms / 1000).toFixed(1)}s`
    );
    const totals = [
      `  tests ${data.totals.tests}, skipped ${data.totals.skipped_tests}`,
      `  coverage ${data.totals.coverage_lines === null ? 'not measured' : `${data.totals.coverage_lines}%`}`
    ];
    const full = [header, ...gateLines, '', ...totals];
    if (full.length <= SUCCESS_LINE_CAP) return full;
    return [header, `  ✓ all ${data.gates.length} gates`, '', ...totals];
  }

  const failure = data.failure ?? { gate: 'unknown', subject: '', excerpt: [] };
  const head = [
    `verify (${form}) FAILED at gate: ${failure.gate}`,
    `  ${failure.subject || '(the gate produced no diagnosis)'}`
  ];
  // Sized from the subject budget rather than a hand-picked number: the gate
  // statuses are context, and they may never grow to the point where the one
  // line naming what broke has scrolled out of the first screenful.
  const otherGateRoom = Math.max(0, SUBJECT_WITHIN_LINES - head.length - 1);
  const others = data.gates
    .filter(gate => gate.id !== failure.gate)
    .slice(0, otherGateRoom)
    .map(gate => `  ${gate.ok ? '✓' : '✗'} ${gate.id}`);
  const room = FAILURE_LINE_CAP - head.length - others.length - 1;
  const excerpt = failure.excerpt.slice(-Math.max(0, Math.min(EXCERPT_LINE_CAP, room)));
  return [...head, ...others, '', ...excerpt].slice(0, FAILURE_LINE_CAP);
}

/**
 * Reads structure out of the runner's own JSON report.
 *
 * Skip reasons come from the suite title marker — `[needs: ffmpeg]` — and not
 * from a ledger file, a global, or a reporter plugin. A skipped test carrying no
 * marker fails the run: an unexplained skip is indistinguishable from a gap, and
 * treating it as one is the whole of SC-007.
 */
export function readSuiteReport(report) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = results.flatMap(file =>
    Array.isArray(file.assertionResults) ? file.assertionResults : []
  );
  const skipped = assertions.filter(
    assertion => assertion.status === 'pending' || assertion.status === 'skipped'
  );
  const skipReasons = {};
  const unexplained = [];
  const failed = [];
  for (const file of results) {
    const fileAssertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const assertion of fileAssertions.filter(assertion => assertion.status === 'failed')) {
      const title = [...(assertion.ancestorTitles ?? []), assertion.title ?? '']
        .filter(Boolean)
        .join(' > ');
      const fileName = typeof file.name === 'string' ? path.relative(root, file.name) : '';
      const firstMessage = Array.isArray(assertion.failureMessages)
        ? String(assertion.failureMessages[0] ?? '').split(/\r?\n/u)[0]
        : '';
      failed.push(
        [fileName, title].filter(Boolean).join(' > ') + (firstMessage ? ` — ${firstMessage}` : '')
      );
    }
  }
  for (const assertion of skipped) {
    const title = `${assertion.ancestorTitles?.join(' ') ?? ''} ${assertion.title ?? ''}`;
    const marker = /\[needs:\s*([^\]]+)\]/u.exec(title);
    if (!marker) {
      unexplained.push(title.trim());
      continue;
    }
    for (const name of marker[1]
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)) {
      skipReasons[name] = (skipReasons[name] ?? 0) + 1;
    }
  }
  return {
    tests: assertions.length,
    skipped: skipped.length,
    skipReasons,
    unexplained,
    failed
  };
}

/**
 * Repo-relative form of a path the coverage provider reported.
 *
 * The provider has emitted both forms: the committed baseline holds relative
 * paths, and the summary produced today holds absolute ones. Compared as
 * written, every floor reads "listed as critical but not measured" and every
 * baselined file reads "no longer measured" — 334 failures describing nothing
 * about coverage. Normalising here means the verdict does not depend on which
 * form the provider happens to be in.
 *
 * @param {string} key
 * @returns {string}
 */
function relativeCoverageKey(key) {
  const withoutRoot = key.startsWith(root) ? key.slice(root.length) : key;
  return withoutRoot.replace(/^[/\\]+/u, '');
}

/**
 * The coverage verdict: critical floors first, the ratchet second.
 *
 * The order is the requirement (FR-018). A run-state module below its absolute
 * floor fails even when the global rose, because a global average is exactly
 * the instrument that lets an uncovered state module hide — it is one file
 * among hundreds, and the average has no opinion about which ones matter.
 *
 * Returns null when there is nothing to judge, so the fast form (which does not
 * measure coverage) is not silently treated as a fall to zero.
 *
 * @param {{
 *   summary: Record<string, { lines?: { pct?: number } }> | null,
 *   baseline: { total_lines?: number, files?: Record<string, number> } | null,
 *   critical: { modules?: Record<string, number> } | null
 * }} input
 * @returns {{ total: number, files: Record<string, number>, failures: string[] } | null}
 */
export function judgeCoverage({ summary, baseline, critical }) {
  if (!summary) return null;
  /** @type {Record<string, number>} */
  const files = {};
  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;
    files[relativeCoverageKey(key)] = Number(entry?.lines?.pct ?? 0);
  }
  const total = Number(summary.total?.lines?.pct ?? 0);
  const failures = [];

  // 1. Absolute floors, independently of anything the global did.
  for (const [module, floor] of Object.entries(critical?.modules ?? {})) {
    const measured = files[module];
    if (measured === undefined) {
      failures.push(`${module}: listed as critical but not measured`);
      continue;
    }
    if (measured < floor) {
      failures.push(`${module}: ${measured}% is below its floor of ${floor}%`);
    }
  }

  // 2. Then the ratchet.
  if (baseline) {
    if (total < Number(baseline.total_lines ?? 0)) {
      failures.push(`global line coverage fell from ${baseline.total_lines}% to ${total}%`);
    }
    for (const [file, was] of Object.entries(baseline.files ?? {})) {
      const now = files[file];
      if (now === undefined) {
        failures.push(`${file}: baselined but no longer measured`);
        continue;
      }
      if (now < was - FILE_FALL_TOLERANCE_POINTS) {
        failures.push(`${file}: fell from ${was}% to ${now}%`);
      }
    }
  }

  return { total, files, failures };
}

/** Reads a JSON file, or null when it is absent or unreadable. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Reads the runner's report if it was written; a missing one is not a failure of its own. */
function readSuiteFile() {
  try {
    return readSuiteReport(JSON.parse(readFileSync(SUITE_REPORT_FILE, 'utf8')));
  } catch {
    // The suite may have died before writing anything — in which case the gate
    // itself has already failed and is the better diagnosis.
    return null;
  }
}

/**
 * Rewrites the committed baseline from the run that just happened.
 *
 * Deliberately a flag rather than something the aggregator does when the figure
 * rises: a baseline that updates itself records whatever the last run produced,
 * including a fall nobody looked at.
 */
function writeBaseline(coverage) {
  const existing = readJson(COVERAGE_BASELINE_FILE) ?? {};
  writeFileSync(
    COVERAGE_BASELINE_FILE,
    `${JSON.stringify(
      { ...existing, total_lines: coverage.total, files: coverage.files },
      null,
      2
    )}\n`
  );
  process.stdout.write(`Coverage baseline updated: ${coverage.total}% of lines.\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.form !== 'fast' && args.form !== 'release') {
    process.stderr.write('verify: --form=fast|release is required.\n');
    process.exit(1);
  }

  const startedAt = Date.now();
  const gates = [];
  let failure = null;

  let suite = null;

  for (const name of phasesFor(args.form, args.gates)) {
    const phase = PHASES[name];
    const results = await runPhase(phase.gates(args.form), { exclusive: phase.exclusive });
    for (const result of results) {
      gates.push(result);
      if (!result.ok && !failure) {
        failure = { gate: result.id, subject: result.subject, excerpt: result.lines };
      }
    }

    if (name === 'suite') {
      const report = readSuiteFile();
      const unexplained = report?.unexplained ?? [];
      suite = report;
      // Vitest's text output can contain thousands of lines, while the gate
      // deliberately retains only a bounded tail. Its JSON report carries the
      // exact failed test titles, so use those exact titles as the actionable
      // diagnosis instead of forcing a second CI run just to discover names.
      if (failure?.gate === 'suite' && report?.failed.length) {
        failure = {
          gate: 'suite',
          subject: report.failed[0],
          excerpt: report.failed
        };
      }
      const coverage = judgeCoverage({
        summary: readJson(COVERAGE_SUMMARY_FILE),
        baseline: readJson(COVERAGE_BASELINE_FILE),
        critical: readJson(COVERAGE_CRITICAL_FILE)
      });
      if (coverage) {
        suite = { ...(suite ?? {}), coverageLines: coverage.total };
        if (args.updateCoverageBaseline) {
          writeBaseline(coverage);
        } else if (coverage.failures.length > 0 && !failure) {
          failure = {
            gate: 'coverage',
            subject: coverage.failures[0],
            excerpt: coverage.failures
          };
        }
      }
      // An unexplained skip fails the run wherever it happens (SC-007). A test
      // that reports as skipped with no stated requirement is indistinguishable
      // from one that has quietly stopped covering anything, and the whole
      // point of the marker is that the difference is machine-readable.
      if (unexplained.length > 0 && !failure) {
        failure = {
          gate: 'suite',
          subject: `${unexplained.length} test(s) skipped without a [needs: …] reason`,
          excerpt: unexplained.slice(0, 40)
        };
      }
    }

    // A strict barrier: a later phase must never read what an earlier one was
    // still writing, and a failure is worth reporting before spending ten more
    // minutes on gates whose result nobody will read.
    if (failure) break;
  }

  const ok = failure === null;
  const result = envelope({ ok, form: args.form, startedAt, gates, failure, suite });
  writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);

  const lines = args.json ? [JSON.stringify(result)] : renderSummary(result);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(ok ? 0 : 1);
}

// Importable for its own test without running anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
