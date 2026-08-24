#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dependency audit, with the distinction the raw command does not make.
 *
 * `npm audit` reports one number for a build-time test helper and for a library
 * that ships to users, and treating those the same has exactly two outcomes:
 * either the gate is advisory and nobody reads it, or it is blocking and gets
 * bypassed the first time a dev-only advisory lands on a Friday.
 *
 * So: production high or critical **blocks**. Development-only findings are
 * counted and printed. And an exception may be granted with an expiry date —
 * which is the part that matters, because an exception without one is a
 * decision nobody revisits. An expired exception fails the gate.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS_FILE = path.join(root, 'audit-exceptions.json');

function auditReport() {
  try {
    // `npm audit` exits non-zero when it finds anything, so the output is read
    // from the thrown result too — a non-zero exit here is data, not an error.
    const stdout = execFileSync('npm', ['audit', '--json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    // `npm audit` exits non-zero whenever it finds anything at all, so the
    // report arrives on the thrown value's stdout. Narrowed rather than cast:
    // a spawn failure lands here too, and it has no stdout to read.
    const thrown = /** @type {{ stdout?: unknown }} */ (error);
    const stdout = typeof thrown.stdout === 'string' ? thrown.stdout : '';
    try {
      return JSON.parse(stdout);
    } catch {
      process.stderr.write('audit: could not read a report from npm audit.\n');
      process.exit(1);
    }
  }
}

/** Exceptions keyed by advisory id, each with a reason and an expiry. */
function exceptions() {
  if (!existsSync(EXCEPTIONS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(EXCEPTIONS_FILE, 'utf8')).advisories ?? {};
  } catch {
    process.stderr.write(`audit: ${EXCEPTIONS_FILE} is not readable JSON.\n`);
    process.exit(1);
  }
}

const report = auditReport();
const granted = exceptions();
const today = new Date().toISOString().slice(0, 10);

const blocking = [];
let developmentOnly = 0;
let excepted = 0;

for (const [name, entry] of Object.entries(report.vulnerabilities ?? {})) {
  const severity = String(entry.severity ?? 'info');
  if (severity !== 'high' && severity !== 'critical') continue;
  if (entry.isDirect === false && entry.effects?.length === 0) continue;

  const exception = granted[name];
  if (exception) {
    if (exception.expires < today) {
      blocking.push(`${name}: exception expired on ${exception.expires} (${exception.reason})`);
    } else {
      excepted += 1;
    }
    continue;
  }

  // `dev: true` means every path to this package runs at build or test time and
  // none of it reaches a user's machine.
  if (entry.dev === true) {
    developmentOnly += 1;
    continue;
  }
  blocking.push(`${name}: ${severity}`);
}

const totals = report.metadata?.vulnerabilities ?? {};
process.stdout.write(
  `audit: ${totals.total ?? 0} advisories ` +
    `(${developmentOnly} development-only, ${excepted} excepted, ${blocking.length} blocking)\n`
);

if (blocking.length > 0) {
  for (const line of blocking) process.stdout.write(`  ${line}\n`);
  process.exit(1);
}
