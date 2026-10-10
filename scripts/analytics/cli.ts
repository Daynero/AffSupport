/**
 * Soty analytics CLI — argument parsing and command dispatch, kept apart from
 * the process entry (`index.ts`) so tests can run a command end to end against
 * an in-process Postgres and read the exact envelope the agent will see.
 *
 * Everything here is read-only: the only file this module ever writes is the
 * `audit --write` artifact under `specs/031-platform-autoanalytics/analysis/`,
 * and only when asked.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatAudit,
  formatCompressor,
  formatConnection,
  formatEvents,
  formatFunnel,
  formatCohorts,
  formatErrors,
  formatFeatures,
  formatFriction,
  formatInspect,
  formatJourney,
  formatRetention,
  formatStages,
  formatOverview,
  formatTools,
  formatTopUsers,
  formatSyncJobs,
  formatTeamWorkspace,
  formatUserDetail,
  formatUsers
} from './format.js';
import { asOfDate, resolvePeriod } from './periods.js';
import {
  getAudit,
  getCompressor,
  getConnection,
  getDeliveryLag,
  getEvents,
  getFunnel,
  getCohorts,
  getErrors,
  getFeatures,
  getFriction,
  getInspect,
  getJourney,
  getOnboarding,
  getRetention,
  getRun,
  getSyncJobs,
  getUpdates,
  diagnoseFingerprint,
  featureUnsupportedSignals,
  getOverview,
  getTools,
  getTopUsers,
  getTeamWorkspace,
  getUserDetail,
  getUsers
} from './queries.js';
import {
  NO_AGENT_CONTEXT_NOTE,
  syncOutputIsPrivate,
  teamWorkspaceOutputIsPrivate,
  type AuditArtifact,
  type CohortsData,
  type ResolvedPeriod
} from './types.js';

export interface ParsedArgs {
  command: string;
  positional: string[];
  period?: string;
  days?: number;
  asOf?: string;
  by?: string;
  limit?: number;
  cohortBy?: string;
  json: boolean;
  write: boolean;
  help: boolean;
}

export const HELP = `Soty analytics CLI (read-only)

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
  onboarding          First-run and pairing funnel
  updates             Update discovery and completion funnel
  errors              Error clusters by stage/build/fingerprint
  friction            Sessions where users became stuck
  features            Feature discovery and use
  journey <email>     Ordered diagnostic timeline for one user (--period, default 30d)
  run <uuid>          Timeline for one operation
  inspect <id>        One attempt across every tool: stages, terminal, lag (flow/run/attempt id)
  diagnose <id>       Events matching an error fingerprint
  cohorts             Compare versions/platforms/builds
  retention           Return activity after registration
  team-workspace      SC-001/SC-005 cohorts + four independent SC-009 weeks
  sync <team-id|owner-email>  Catalog sync jobs of one space: state, waits, errors
  connection          Browser ↔ Agent link: losses, recovery time, reasons, coverage
  audit               Coverage registry vs observed events: blind spots, orphans, losses

Options:
  --period <t>   today | 7d | 30d | 90d | all  (default 7d)
  --days <n>     rolling N-day window (overrides --period)
  --as-of <iso>  fix the window's end to this instant (repeatable analysis)
  --by <field>   top-users: activity | compressions (default compressions)
  --limit <n>    row limit (default 10)
  --cohort-by <v> local-app-version | platform | web-build
  --write        audit: save specs/031-platform-autoanalytics/analysis/<date>.json
  --json         machine-readable JSON only
  -h, --help     this help

Examples:
  npm run analytics -- overview --period all
  npm run analytics -- compressor --days 7 --json
  npm run analytics -- top-users --by compressions --period 30d
  npm run analytics -- audit --period 30d --as-of 2026-10-10T00:00:00Z --json --write
  npm run analytics -- inspect 1b1e6d8c-0c2d-4f0e-8c6e-2a6a1a2b3c4d --json`;

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: '',
    positional: [],
    json: false,
    write: false,
    help: false
  };
  const rest = [...argv];
  while (rest.length) {
    const token = rest.shift() as string;
    switch (token) {
      case '--json':
        parsed.json = true;
        break;
      case '--write':
        parsed.write = true;
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
      case '--as-of':
        parsed.asOf = rest.shift();
        if (parsed.asOf === undefined) throw new Error('--as-of needs an ISO-8601 instant');
        break;
      case '--by':
        parsed.by = rest.shift();
        break;
      case '--limit':
        parsed.limit = Number(rest.shift());
        break;
      case '--cohort-by':
        parsed.cohortBy = rest.shift();
        break;
      default:
        if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
        if (!parsed.command) parsed.command = token;
        else parsed.positional.push(token);
    }
  }
  return parsed;
}

/** A command that could not run; `hint` is extra human text (the help, for instance). */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
  }
}

export interface CommandResult<T = unknown> {
  period: ResolvedPeriod;
  data: T;
  human: string;
  /** Files the command wrote (only `audit --write`). */
  written: string[];
}

export interface ExecuteOptions {
  /** Where `audit --write` saves its artifact. Defaults to the spec's analysis folder. */
  analysisDir?: string;
}

export const DEFAULT_ANALYSIS_DIR = 'specs/031-platform-autoanalytics/analysis';

function requireArg(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positional[index];
  if (!value) throw new CommandError(`Missing argument. Usage: ${usage}`);
  return value;
}

export async function executeCommand(
  args: ParsedArgs,
  options: ExecuteOptions = {}
): Promise<CommandResult> {
  const command = args.command;
  const period = resolvePeriod(args.period, args.days, args.asOf);
  const lag = () => getDeliveryLag(period);
  const done = <T>(data: T, human: string, written: string[] = []): CommandResult<T> => ({
    period,
    data,
    human,
    written
  });

  switch (command) {
    case 'overview': {
      const [data, delivery_lag_ms] = await Promise.all([getOverview(period), lag()]);
      const full = { ...data, delivery_lag_ms };
      return done(full, formatOverview(full, period));
    }
    case 'compressor': {
      const [data, delivery_lag_ms] = await Promise.all([getCompressor(period), lag()]);
      const full = { ...data, delivery_lag_ms };
      return done(full, formatCompressor(full, period));
    }
    case 'users': {
      const data = await getUsers(period, args.limit ?? 10);
      return done(data, formatUsers(data, period));
    }
    case 'top-users': {
      const by = args.by === 'activity' ? 'activity' : 'compressions';
      const data = await getTopUsers(period, by, args.limit ?? 10);
      return done(data, formatTopUsers(data, period));
    }
    case 'user': {
      const email = requireArg(args, 0, 'user <email>');
      const data = await getUserDetail(email, args.limit ?? 20);
      if (!data) throw new CommandError(`No user found for "${email}".`);
      return done(data, formatUserDetail(data));
    }
    case 'tools': {
      const [tools, delivery_lag_ms] = await Promise.all([getTools(period), lag()]);
      const full = { tools, delivery_lag_ms };
      return done(full, formatTools(full, period));
    }
    case 'events': {
      const [events, delivery_lag_ms] = await Promise.all([getEvents(period), lag()]);
      const full = { events, delivery_lag_ms };
      return done(full, formatEvents(full, period));
    }
    case 'funnel': {
      const [stages, delivery_lag_ms] = await Promise.all([getFunnel(period), lag()]);
      const full = { stages, delivery_lag_ms };
      return done(full, formatFunnel(full, period));
    }
    case 'onboarding': {
      const [stages, delivery_lag_ms] = await Promise.all([getOnboarding(period), lag()]);
      const full = { stages, delivery_lag_ms };
      return done(full, formatStages('Onboarding', full, period));
    }
    case 'updates': {
      const [stages, delivery_lag_ms] = await Promise.all([getUpdates(period), lag()]);
      const full = { stages, delivery_lag_ms };
      return done(full, formatStages('Updates', full, period));
    }
    case 'errors': {
      const [clusters, delivery_lag_ms] = await Promise.all([
        getErrors(period, args.limit ?? 50),
        lag()
      ]);
      const full = { clusters, delivery_lag_ms };
      return done(full, formatErrors(full, period));
    }
    case 'friction': {
      const [signals, delivery_lag_ms] = await Promise.all([getFriction(period), lag()]);
      const full = { signals, delivery_lag_ms };
      return done(full, formatFriction(full, period));
    }
    case 'features': {
      const [features, delivery_lag_ms] = await Promise.all([getFeatures(period), lag()]);
      const full = { features, unsupported: featureUnsupportedSignals(), delivery_lag_ms };
      return done(full, formatFeatures(full, period));
    }
    case 'journey': {
      const email = requireArg(args, 0, 'journey <email>');
      // FR-055: a bounded read by default; `--period all` restores the old behaviour.
      const journeyPeriod = resolvePeriod(args.period ?? '30d', args.days, args.asOf);
      const [events, delivery_lag_ms] = await Promise.all([
        getJourney(email, args.limit ?? 200, journeyPeriod),
        getDeliveryLag(journeyPeriod)
      ]);
      const full = { events, delivery_lag_ms };
      return {
        period: journeyPeriod,
        data: full,
        human: formatJourney(`Journey · ${email}`, events, journeyPeriod, delivery_lag_ms),
        written: []
      };
    }
    case 'run': {
      const runId = requireArg(args, 0, 'run <uuid>');
      const data = await getRun(runId, args.limit ?? 500, period.as_of);
      return done(data, formatJourney(`Run · ${runId}`, data));
    }
    case 'inspect': {
      const id = requireArg(args, 0, 'inspect <flow_id | run_id | attempt_id>');
      const data = await getInspect(id, period.as_of, args.limit ?? 500);
      return done(data, formatInspect(data));
    }
    case 'diagnose': {
      const fingerprint = requireArg(args, 0, 'diagnose <fingerprint>');
      const data = await diagnoseFingerprint(fingerprint, args.limit ?? 200, period.as_of);
      return done(data, formatJourney(`Error · ${fingerprint}`, data));
    }
    case 'cohorts': {
      const cohortBy: CohortsData['cohort_by'] =
        args.cohortBy === 'platform' || args.cohortBy === 'web-build'
          ? args.cohortBy
          : 'local-app-version';
      const [cohorts, delivery_lag_ms] = await Promise.all([getCohorts(period, cohortBy), lag()]);
      const full = { cohort_by: cohortBy, cohorts, note: NO_AGENT_CONTEXT_NOTE, delivery_lag_ms };
      return done(full, formatCohorts(full, period));
    }
    case 'retention': {
      const [data, delivery_lag_ms] = await Promise.all([getRetention(period), lag()]);
      const full = { ...data, delivery_lag_ms };
      return done(full, formatRetention(full, period));
    }
    case 'sync': {
      const target = requireArg(args, 0, 'sync <team-id | owner-email>');
      const data = await getSyncJobs(target, args.limit ?? 50);
      if (!data) throw new CommandError(`No sync jobs found for "${target}".`);
      if (!syncOutputIsPrivate(data)) {
        throw new CommandError('Sync diagnostics failed their privacy guard.');
      }
      return done(data, formatSyncJobs(data, period));
    }
    case 'connection': {
      const [data, delivery_lag_ms] = await Promise.all([getConnection(period), lag()]);
      const full = { ...data, delivery_lag_ms };
      return done(full, formatConnection(full, period));
    }
    case 'team-workspace': {
      const [data, delivery_lag_ms] = await Promise.all([getTeamWorkspace(period), lag()]);
      if (!teamWorkspaceOutputIsPrivate(data)) {
        throw new CommandError('Team workspace aggregate failed its privacy guard.');
      }
      const full = { ...data, delivery_lag_ms };
      return done(full, formatTeamWorkspace(full, period));
    }
    case 'audit': {
      const data = await getAudit(period);
      const written: string[] = [];
      if (args.write) {
        const artifact: AuditArtifact = {
          ok: true,
          command: 'audit',
          as_of: period.as_of ?? period.end,
          period,
          data
        };
        const dir = resolve(process.cwd(), options.analysisDir ?? DEFAULT_ANALYSIS_DIR);
        mkdirSync(dir, { recursive: true });
        const file = resolve(dir, `${asOfDate(period)}.json`);
        writeFileSync(file, JSON.stringify(artifact, null, 2) + '\n');
        written.push(file);
      }
      return done(data, formatAudit(data, period, written), written);
    }
    default:
      throw new CommandError(`Unknown command "${command || '(none)'}"`, HELP);
  }
}
