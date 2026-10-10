#!/usr/bin/env -S npx tsx
/**
 * Soty analytics CLI — read-only, developer/agent-side product analytics.
 *
 * Usage:
 *   npm run analytics -- <command> [options]
 *
 * The command list and options live in `cli.ts` (`HELP`); this file only
 * parses the process arguments, runs one command and prints the envelope.
 *
 * Everything is read-only: the CLI connects as a dedicated SELECT-only role in a
 * forced read-only session and refuses any non-SELECT SQL. It never writes to
 * the database. The one file it can write is the `audit --write` artifact under
 * `specs/031-platform-autoanalytics/analysis/`.
 */
import { CommandError, HELP, executeCommand, parseArgs, type ParsedArgs } from './cli.js';
import { closePool } from './db.js';
import { buildCommandEnvelope, type ErrorEnvelope } from './types.js';

function writeError(json: boolean, command: string, error: string, hint?: string): void {
  if (json) {
    const envelope: ErrorEnvelope = { ok: false, command, error, ...(hint ? { hint } : {}) };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stderr.write(`Error: ${error}\n${hint ? hint + '\n' : ''}`);
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`);
    process.exitCode = 1;
    return;
  }

  if (args.help || !args.command) {
    process.stdout.write(HELP + '\n');
    return;
  }

  try {
    const result = await executeCommand(args);
    if (args.json) {
      const envelope = buildCommandEnvelope(args.command, result.period, result.data);
      process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
    } else {
      process.stdout.write(result.human + '\n');
    }
  } catch (error) {
    const hint = error instanceof CommandError ? error.hint : undefined;
    writeError(args.json, args.command || 'unknown', (error as Error).message, hint);
  } finally {
    await closePool().catch(() => undefined);
  }
}

void main();
