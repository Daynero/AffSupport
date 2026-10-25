import { spawn } from 'node:child_process';
import { admissionFromEnvironment } from './release/admission-client.mjs';
import { terminateGateTree } from './gate-process-tree.mjs';

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
const WEB_CLEANUP_SENTINEL = 'WEB_MANAGED_CLEANUP_UNCONFIRMED';

// Only the web-only supervisor opts in. Once its owner was cancelled, this
// process must not start another heavy gate even if the phase loop continues.
let webManagedCancelled = false;
const webManaged = () => process.env.SOTY_WEB_MANAGED_TREE === '1';

function cancelledGate(gate) {
  const line = `Gate '${gate.id}' was not started: managed verification was cancelled.`;
  return { id: gate.id, ok: false, duration_ms: 0, timedOut: false, lines: [line], subject: line };
}

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
  if (webManaged() && webManagedCancelled) return cancelledGate(gate);
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
  if (webManaged() && webManagedCancelled) return cancelledGate(gate);
  const managed = webManaged();
  const depth = Number(process.env.SOTY_WEB_MANAGED_DEPTH ?? '0');
  if (managed && (!Number.isSafeInteger(depth) || depth < 0 || depth >= 8))
    return admissionFailure(gate, new Error('WEB_MANAGED_GATE_DEPTH_UNSUPPORTED'));
  const startedAt = Date.now();
  const ring = new OutputRing();
  const timeoutMessage =
    `Gate '${gate.id}' exceeded its ${gate.timeoutMs} ms budget. ` +
    'A gate that hangs fails; it does not hold the command open.';

  const result = await new Promise(resolve => {
    let child;
    try {
      child = spawn(gate.command, gate.args, {
        shell: gate.shell ?? false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...gate.env,
          ...(managed
            ? { SOTY_WEB_MANAGED_TREE: '1', SOTY_WEB_MANAGED_DEPTH: String(depth + 1) }
            : {})
        }
      });
    } catch (error) {
      ring.push(messageOf(error));
      resolve({ ok: false, timedOut: false });
      return;
    }

    let settled = false;
    /** @type {NodeJS.Timeout|null} */
    let cancellationTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let cancellationDrain = null;
    /** @type {NodeJS.Timeout|null} */
    let cancellationPoll = null;
    /** @type {string|null} */
    let cancellation = null;
    const term = () => cancel('SIGTERM');
    const interrupt = () => cancel('SIGINT');
    const groupAbsent = () => {
      if (!child.pid) return true;
      if (process.platform === 'win32') return false;
      try {
        process.kill(-child.pid, 0);
        return false;
      } catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'ESRCH';
      }
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      if (cancellationDrain) clearTimeout(cancellationDrain);
      if (cancellationPoll) clearTimeout(cancellationPoll);
      if (managed) {
        process.removeListener('SIGTERM', term);
        process.removeListener('SIGINT', interrupt);
      }
      resolve(value);
    };

    function cancel(reason) {
      if (settled || cancellation) return;
      webManagedCancelled = true;
      cancellation = reason;
      clearTimeout(timer);
      ring.push(`Gate '${gate.id}' cancelled by ${reason}; no later managed gate will start.`);
      const pid = child.pid;
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-pid, 'SIGTERM');
        } catch {
          // The forced tree cleanup below reports whether termination is known.
        }
      }
      // Nested runGate owners receive a smaller grace than their parent, so
      // they can terminate their own detached children before being escalated.
      const graceMs = Math.max(1, Math.floor(500 / 2 ** depth));
      cancellationTimer = setTimeout(() => {
        terminateGateTree(child);
        const complete = confirmed => {
          if (settled) return;
          if (!confirmed) {
            ring.push(WEB_CLEANUP_SENTINEL);
            // The outer managed owner must see uncertainty even if it needs
            // to terminate this aggregator before it can print its report.
            process.stderr.write(
              `${WEB_CLEANUP_SENTINEL}: owned process group ${child.pid ?? 'unknown'}\n`
            );
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          finish({ ok: false, timedOut: reason === 'timeout' });
        };
        const observe = () => {
          if (settled) return;
          if (groupAbsent()) {
            complete(true);
            return;
          }
          cancellationPoll = setTimeout(observe, 10);
        };
        cancellationDrain = setTimeout(
          () => complete(groupAbsent()),
          Math.max(1, Math.floor(250 / 2 ** depth))
        );
        observe();
      }, graceMs);
    }

    if (managed) {
      process.on('SIGTERM', term);
      process.on('SIGINT', interrupt);
    }

    const timer = setTimeout(() => {
      ring.push(timeoutMessage);
      if (managed) {
        cancel('timeout');
        return;
      }
      const termination = terminateGateTree(child);
      ring.push(
        termination === 'unconfirmed'
          ? 'Owned gate process-tree termination is unconfirmed; descendants may remain.'
          : 'Termination requested for the owned gate process tree.'
      );
      // A refused tree kill must not leave inherited output pipes holding the
      // verifier open forever. Its result remains failed and explicitly uncertain.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ ok: false, timedOut: true });
    }, gate.timeoutMs);
    timer.unref?.();

    let forwardedUncertainty = false;
    const capture = () => {
      let tail = '';
      return chunk => {
        const text = String(chunk);
        ring.push(text);
        if (!managed || forwardedUncertainty) return;
        const combined = tail + text;
        if (combined.includes(WEB_CLEANUP_SENTINEL)) {
          forwardedUncertainty = true;
          // Nested owners have private stdout/stderr pipes. Propagate their
          // uncertainty immediately instead of waiting for report rendering.
          process.stderr.write(`${WEB_CLEANUP_SENTINEL}\n`);
        }
        tail = combined.slice(-(WEB_CLEANUP_SENTINEL.length - 1));
      };
    };
    child.stdout?.on('data', capture());
    child.stderr?.on('data', capture());
    child.once('error', error => {
      ring.push(messageOf(error));
      if (cancellation) return;
      finish({ ok: false, timedOut: false });
    });
    child.once('close', code => {
      // Even an exited wrapper may have left members in its private group.
      // Keep the escalation timer alive through close during cancellation.
      if (cancellation) return;
      if (managed && !groupAbsent()) {
        cancel(code === 0 ? 'lingering_descendants' : 'failed_owner_descendants');
        return;
      }
      // A nested owner reports its own cancellation as a failed exit. Do not
      // start new managed work after that owner has stopped its detached tree.
      if (managed && code !== 0) webManagedCancelled = true;
      finish({ ok: code === 0, timedOut: false });
    });
  });

  const lines = ring.lines();
  return {
    id: gate.id,
    ok: result.ok,
    duration_ms: Date.now() - startedAt,
    timedOut: result.timedOut,
    lines,
    subject: result.ok ? '' : result.timedOut ? timeoutMessage : subjectFor(gate.id, lines)
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
