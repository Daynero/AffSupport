#!/usr/bin/env -S npx tsx
/**
 * Wishly analytics CLI — read-only, developer/agent-side product analytics.
 *
 * Usage:
 *   npm run analytics -- <command> [options]
 *
 * Commands:
 *   overview            High-level product metrics for the period.
 *   compressor          Detailed compressor funnel and size/ratio metrics.
 *   users               User totals + most recently active users.
 *   top-users           Ranking by activity or compressions (--by).
 *   user <email>        Everything about a single user (all-time).
 *   tools               Per-tool opens / users / starts / completions.
 *   events              Event-name breakdown with unique users.
 *   funnel              Compressor conversion funnel by unique users.
 *
 * Options:
 *   --period <token>    today | 7d | 30d | 90d | all   (default: 7d)
 *   --days <n>          Rolling window of N days (overrides --period).
 *   --by <field>        top-users: activity | compressions (default: compressions)
 *   --limit <n>         Row limit for list commands (default: 10, user: 20).
 *   --json              Emit stable machine-readable JSON only.
 *   -h, --help          Show this help.
 *
 * Everything is read-only: the CLI connects as a dedicated SELECT-only role in a
 * forced read-only session and refuses any non-SELECT SQL. It never writes.
 */
import { closePool } from './db.js';
import {
  formatCompressor,
  formatEvents,
  formatFunnel,
  formatOverview,
  formatTools,
  formatTopUsers,
  formatUserDetail,
  formatUsers
} from './format.js';
import { resolvePeriod } from './periods.js';
import {
  getCompressor,
  getEvents,
  getFunnel,
  getOverview,
  getTools,
  getTopUsers,
  getUserDetail,
  getUsers
} from './queries.js';
import type { CommandEnvelope, ErrorEnvelope } from './types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  period?: string;
  days?: number;
  by?: string;
  limit?: number;
  json: boolean;
  help: boolean;
}

const HELP = `Wishly analytics CLI (read-only)

Usage: npm run analytics -- <command> [options]

Commands:
  overview            High-level product metrics
  compressor          Compressor funnel + size/ratio metrics
  users               User totals + recently active
  top-users           Ranking (--by activity|compressions)
  user <email>        Full detail for one user (all-time)
  tools               Per-tool usage
  events              Event-name breakdown
  funnel              Compressor conversion funnel

Options:
  --period <t>   today | 7d | 30d | 90d | all  (default 7d)
  --days <n>     rolling N-day window (overrides --period)
  --by <field>   top-users: activity | compressions (default compressions)
  --limit <n>    row limit (default 10)
  --json         machine-readable JSON only
  -h, --help     this help

Examples:
  npm run analytics -- overview --period all
  npm run analytics -- compressor --days 7 --json
  npm run analytics -- top-users --by compressions --period 30d
  npm run analytics -- user someone@example.com --json`;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: '', positional: [], json: false, help: false };
  const rest = [...argv];
  while (rest.length) {
    const token = rest.shift() as string;
    switch (token) {
      case '--json':
        parsed.json = true;
        break;
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--period':
        parsed.period = rest.shift();
        break;
      case '--days':
        parsed.days = Number(rest.shift());
        break;
      case '--by':
        parsed.by = rest.shift();
        break;
      case '--limit':
        parsed.limit = Number(rest.shift());
        break;
      default:
        if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
        if (!parsed.command) parsed.command = token;
        else parsed.positional.push(token);
    }
  }
  return parsed;
}

function emit<T>(
  args: ParsedArgs,
  command: string,
  period: CommandEnvelope<T>['period'],
  data: T,
  human: string
): void {
  if (args.json) {
    const envelope: CommandEnvelope<T> = {
      ok: true,
      command,
      generated_at: new Date().toISOString(),
      period,
      data
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stdout.write(human + '\n');
  }
}

function writeError(json: boolean, command: string, error: string, hint?: string): void {
  if (json) {
    const envelope: ErrorEnvelope = { ok: false, command, error, ...(hint ? { hint } : {}) };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stderr.write(`Error: ${error}\n${hint ? hint + '\n' : ''}`);
  }
  process.exitCode = 1;
}

function fail(args: { json?: boolean }, command: string, error: string, hint?: string): never {
  writeError(Boolean(args.json), command, error, hint);
  throw new ExitSignal();
}

class ExitSignal extends Error {}

async function run(args: ParsedArgs): Promise<void> {
  const command = args.command;
  const period = resolvePeriod(args.period, args.days);

  switch (command) {
    case 'overview': {
      const data = await getOverview(period);
      emit(args, command, period, data, formatOverview(data, period));
      break;
    }
    case 'compressor': {
      const data = await getCompressor(period);
      emit(args, command, period, data, formatCompressor(data, period));
      break;
    }
    case 'users': {
      const data = await getUsers(period, args.limit ?? 10);
      emit(args, command, period, data, formatUsers(data, period));
      break;
    }
    case 'top-users': {
      const by = args.by === 'activity' ? 'activity' : 'compressions';
      const data = await getTopUsers(period, by, args.limit ?? 10);
      emit(args, command, period, data, formatTopUsers(data, period));
      break;
    }
    case 'user': {
      const email = args.positional[0];
      if (!email) fail(args, command, 'Missing email. Usage: user <email>');
      const data = await getUserDetail(email, args.limit ?? 20);
      if (!data) fail(args, command, `No user found for "${email}".`);
      emit(args, command, period, data, formatUserDetail(data));
      break;
    }
    case 'tools': {
      const data = await getTools(period);
      emit(args, command, period, data, formatTools(data, period));
      break;
    }
    case 'events': {
      const data = await getEvents(period);
      emit(args, command, period, data, formatEvents(data, period));
      break;
    }
    case 'funnel': {
      const data = await getFunnel(period);
      emit(args, command, period, data, formatFunnel(data, period));
      break;
    }
    default:
      fail(args, command || 'unknown', `Unknown command "${command || '(none)'}"`, HELP);
  }
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
    await run(args);
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      writeError(args.json, args.command, (error as Error).message);
    }
  } finally {
    await closePool().catch(() => undefined);
  }
}

void main();
