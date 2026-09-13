#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_PROTOCOL_VERSION,
  completeJob,
  handleRequest,
  listJobs,
  readJob
} from './lib/release/bridge-inbox.mjs';

/**
 * The repair bridge: where a release that fails at 3am goes to ask for help.
 *
 * The runner has known this protocol since it was written and had nothing to
 * talk to — which is why it has never cut a release. Its preflight refuses to
 * start heavy work without a bridge, and that refusal is correct: an unattended
 * release whose failures reach nobody is worse than one that does not start.
 *
 * What this is: a durable inbox. A failure arrives as one JSON record in a
 * directory, kept whether or not anybody is watching, and the answer a person
 * writes back flows to the runner through the same protocol. What it is not is
 * a stand-in — `release-acceptance.mjs` exists to refuse those, and rightly. It
 * does not repair anything, does not run a model, and never reports a repair
 * nobody made.
 *
 * Transport (spoken by the runner, one process per message):
 *   --release-bridge-health   prints {"ok":true,"protocolVersion":1}
 *   --release-bridge          one JSON request on stdin, one reply on stdout
 *
 * Inbox (spoken by a person or an agent):
 *   --list                              what is waiting, and what it was about
 *   --show <jobId>                      the whole record, diagnostics included
 *   --complete <jobId> --status <s>     repaired | refused | needs_owner
 *                      [--notes <text>]
 *
 * `--status repaired` is a claim about the source, never about the gates: the
 * runner re-runs its own verification regardless of what is said here.
 */

const HEALTH_REPLY = JSON.stringify({ ok: true, protocolVersion: BRIDGE_PROTOCOL_VERSION });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function inboxDirectory(env = process.env) {
  return env.SOTY_RELEASE_BRIDGE_DIR?.trim()
    ? path.resolve(env.SOTY_RELEASE_BRIDGE_DIR)
    : path.join(root, 'release/automation/bridge');
}

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? '') : null;
};

function readStdin() {
  return new Promise(resolve => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });
    process.stdin.once('end', () => resolve(input));
    // A transport that never closes stdin must not wedge a release; the runner
    // kills us on its own timeout, and this keeps us honest if it does not.
    setTimeout(() => resolve(input), 20_000).unref?.();
  });
}

const directory = inboxDirectory();

if (args.includes('--release-bridge-health')) {
  process.stdout.write(HEALTH_REPLY);
  process.exit(0);
}

if (args.includes('--release-bridge')) {
  let request;
  try {
    request = JSON.parse((await readStdin()).trim() || '{}');
  } catch {
    // Unparsable input is a message we were never able to be about a job, and
    // an empty request answers `unknown` rather than throwing at the transport.
    request = {};
  }
  const reply = await handleRequest(directory, request);
  process.stdout.write(JSON.stringify(reply));
  process.exit(0);
}

if (args.includes('--list')) {
  const jobs = await listJobs(directory);
  if (!jobs.length) {
    process.stdout.write(`No repair jobs in ${path.relative(root, directory)}.\n`);
    process.exit(0);
  }
  for (const job of jobs) {
    const summary = job.payload?.subject ?? job.payload?.step ?? job.fingerprint;
    process.stdout.write(
      `${job.state.padEnd(12)} ${job.jobId}  ${job.receivedAt}\n  ${summary}\n` +
        (job.result
          ? `  result: ${job.result.status}${job.result.notes ? ` — ${job.result.notes}` : ''}\n`
          : '')
    );
  }
  process.exit(0);
}

if (flag('show')) {
  const job = await readJob(directory, flag('show'));
  if (!job) {
    process.stderr.write(`No job ${flag('show')}.\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(job, null, 2)}\n`);
  process.exit(0);
}

if (flag('complete')) {
  const status = flag('status');
  try {
    const job = await completeJob(directory, flag('complete'), { status, notes: flag('notes') });
    if (!job) {
      process.stderr.write(`No job ${flag('complete')}.\n`);
      process.exit(1);
    }
    process.stdout.write(`${job.jobId} is ${job.state} (${job.result.status}).\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
    process.exit(1);
  }
}

process.stderr.write(
  'Usage: release-bridge --release-bridge-health | --release-bridge | --list | ' +
    '--show <jobId> | --complete <jobId> --status <repaired|refused|needs_owner> [--notes <text>]\n'
);
process.exit(1);
