import { spawn } from 'node:child_process';
import { admissionFromEnvironment } from './release/admission-client.mjs';

/**
 * Running one gate, bounding what it can cost, and keeping its own words.
 *
 * The aggregator is the single point of failure for every check in the
 * repository, so the rules it enforces on a gate are deliberately dull: a gate
 * may not hang, may not fill memory with output, and may not have its diagnosis
 * rewritten. The last one matters most. A gate's excerpt is the tool's own text,
 * truncated — never reformatted — because the promise the verification command
 * makes is that its failure output is sufficient to act on without re-running,
 * and a paraphrase of a TypeScript error is not.
 */

/**
 * How many lines of a gate's output are retained.
 *
 * A ring rather than a cap so the *end* survives: compilers and test runners
 * put the summary last, and a head-truncated log of a 40 000-line build is the
 * one part guaranteed not to name the failure.
 */
const OUTPUT_RING_LINES = 400;

/** Lines longer than this are cut; a minified bundle on one line is not a diagnosis. */
const MAX_LINE_LENGTH = 500;

class OutputRing {
  #lines = [];

  push(text) {
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      this.#lines.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);
      if (this.#lines.length > OUTPUT_RING_LINES) this.#lines.shift();
    }
  }

  lines() {
    return [...this.#lines];
  }
}

/**
 * The first line that looks like a diagnosis, or the last line of output.
 *
 * Deliberately generic: every extractor below is a *preference*, not a parser.
 * A gate whose format changes upstream degrades to "the last thing it said",
 * which is still true, rather than to an empty subject that hides the failure.
 */
function firstMatch(lines, patterns) {
  for (const pattern of patterns) {
    const found = lines.find(line => pattern.test(line));
    if (found) return found.trim();
  }
  return lines.at(-1)?.trim() ?? '';
}

/**
 * Per-gate subject extractors.
 *
 * Keyed by gate id and looked up with a fallback, so a gate added without an
 * extractor still reports something usable rather than throwing here — the
 * aggregator failing while reporting a failure would be the worst possible
 * behaviour for this file.
 */
export const SUBJECT_EXTRACTORS = {
  format: lines => firstMatch(lines, [/^\[warn\]\s+\S/u, /Code style issues/u]),
  lint: lines => firstMatch(lines, [/^\s*\d+:\d+\s+error/u, /^\/.*\.(?:ts|tsx|mjs|js)$/u]),
  typecheck: lines => firstMatch(lines, [/error TS\d+/u]),
  suite: lines =>
    firstMatch(lines, [/^\s*(?:FAIL|×)\s+/u, /Tests\s+\d+\s+failed/u, /AssertionError/u]),
  build: lines => firstMatch(lines, [/error TS\d+/u, /^Error:/u, /\bfailed\b/iu]),
  database: lines => firstMatch(lines, [/^not ok\b/u, /ERROR:/u, /Result:\s*FAIL/u]),
  default: lines => firstMatch(lines, [/\b(?:error|failed|refused)\b/iu])
};

/** The message of a thrown value, whatever it turned out to be. */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Picks an extractor by gate id prefix, so `typecheck:tests` uses `typecheck`. */
export function subjectFor(id, lines) {
  const key = Object.keys(SUBJECT_EXTRACTORS).find(
    name => name !== 'default' && (id === name || id.startsWith(`${name}:`))
  );
  const extract = SUBJECT_EXTRACTORS[key ?? 'default'];
  try {
    return extract(lines);
  } catch {
    return lines.at(-1)?.trim() ?? '';
  }
}

/**
 * Runs one gate to completion, a timeout, or a spawn failure.
 *
 * Never rejects: a gate that cannot start is a *failed gate*, not a crashed
 * aggregator, and the difference decides whether the run produces a result
 * envelope at all.
 */
export async function runGate(gate) {
  let admission;
  try {
    admission = admissionFromEnvironment();
  } catch (error) {
    return admissionFailure(gate, error);
  }
  if (!admission) return runGateNow(gate);
  try {
    // Under a release runner the aggregator is a nested heavy boundary: it waits
    // for the one host-wide slot rather than competing with the step that owns it.
    return await admission.withAdmission(`gate:${gate.id}`, () => runGateNow(gate));
  } catch (error) {
    return admissionFailure(gate, error);
  }
}

/**
 * A gate that could not be admitted is a failed gate, never a skipped one.
 *
 * Reporting it this way keeps the aggregator's one invariant — `runGate` always
 * produces a result — while still failing closed: an incompletely configured
 * admission must not be readable as permission to run heavy work.
 */
function admissionFailure(gate, error) {
  const line = `Gate '${gate.id}' was not admitted: ${messageOf(error)}`;
  return { id: gate.id, ok: false, duration_ms: 0, timedOut: false, lines: [line], subject: line };
}

async function runGateNow(gate) {
  const startedAt = Date.now();
  const ring = new OutputRing();

  const result = await new Promise(resolve => {
    let child;
    try {
      child = spawn(gate.command, gate.args, {
        shell: gate.shell ?? false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...gate.env }
      });
    } catch (error) {
      ring.push(messageOf(error));
      resolve({ ok: false, timedOut: false });
      return;
    }

    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      ring.push(
        `Gate '${gate.id}' exceeded its ${gate.timeoutMs} ms budget and was stopped. ` +
          'A gate that hangs fails; it does not hold the command open.'
      );
      // SIGKILL rather than SIGTERM: this gate has already proven it is not
      // responding to its own schedule, and the aggregator has a result to
      // write either way.
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone between the deadline and the signal.
      }
      finish({ ok: false, timedOut: true });
    }, gate.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', chunk => ring.push(String(chunk)));
    child.stderr?.on('data', chunk => ring.push(String(chunk)));
    child.once('error', error => {
      ring.push(messageOf(error));
      finish({ ok: false, timedOut: false });
    });
    child.once('close', code => finish({ ok: code === 0, timedOut: false }));
  });

  const lines = ring.lines();
  return {
    id: gate.id,
    ok: result.ok,
    duration_ms: Date.now() - startedAt,
    timedOut: result.timedOut,
    lines,
    subject: result.ok ? '' : subjectFor(gate.id, lines)
  };
}

/**
 * Runs a phase: everything in it at once, and nothing after it until all of it
 * has finished.
 *
 * `exclusive` phases run their gates one at a time. Phase B is exclusive for a
 * recorded reason (A17): the suite rebuilds the shared package's committed
 * output and rewrites a tracked migration, which other phases would be reading.
 */
export async function runPhase(
  gates,
  {
    exclusive = false,
    // A runner-driven verification is serial by construction: the admission
    // authority grants one heavy child at a time, so launching gates in
    // parallel would only queue them against each other.
    serial = process.env.SOTY_VERIFY_SERIAL === '1' ||
      Boolean(process.env.SOTY_RELEASE_ADMIT_SOCKET)
  } = {}
) {
  if (!exclusive && !serial) return Promise.all(gates.map(gate => runGate(gate)));
  const results = [];
  for (const gate of gates) results.push(await runGate(gate));
  return results;
}

export { OUTPUT_RING_LINES };
