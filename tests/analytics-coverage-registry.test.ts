import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_TOOLS, analyticsEventNames } from '../apps/web/src/analytics/events';
import { TEAM_ANALYTICS_EVENT_NAMES } from '../packages/shared/src/team/analytics';
import {
  COVERAGE_REGISTRY,
  PENDING_PRODUCER_EVENTS,
  capabilitySignals,
  registryEventNames,
  registryEventStatuses,
  signalStatus
} from '../scripts/analytics/coverage-registry';
import {
  AUDIT_PROBE_EVENT_NAMES,
  DEFERRED_EVENT_NAMES,
  QUERY_EVENT_NAMES
} from '../scripts/analytics/queries';

/**
 * 031 T016 — the coverage registry is the source of truth for what the CLI
 * may compute from. Three invariants keep it honest:
 *  1. every event it names exists in the client contract (or is one of the
 *     names whose producer lands concurrently);
 *  2. every event the CLI's SQL computes from is in the registry;
 *  3. every signal marked `emitted` has a real call site in the web source.
 */

const ROOT = resolve(__dirname, '..');
const CONTRACT_NAMES = new Set<string>([...analyticsEventNames, ...TEAM_ANALYTICS_EVENT_NAMES]);

/**
 * Events the CLI computes from that no call site emits. Empty since 033 T008 gave
 * `team_preview_completed` a producer (SC-004). Add a name here only with a reason; remove it
 * the moment a producer exists.
 */
const KNOWN_DECLARED_BUT_NEVER_EMITTED: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const PRODUCER_SOURCES = [
  ...walk(resolve(ROOT, 'apps/web/src')),
  ...walk(resolve(ROOT, 'packages/shared/src'))
]
  .filter(
    path =>
      !path.endsWith('apps/web/src/analytics/events.ts') &&
      !path.endsWith('packages/shared/src/team/analytics.ts') &&
      !path.endsWith('apps/web/src/lib/database.types.ts')
  )
  .map(path => readFileSync(path, 'utf8'));

/**
 * Names whose only literal lives in a tracking helper nothing calls
 * (`trackTeamLandingGalleryView`, `trackTeamLandingOpen`,
 * `trackCreativeLibraryContribution` in analytics/service.ts). The registry
 * marks them unsupported; a source scan cannot tell a helper from a call site,
 * so they are listed here on purpose. Remove a name when a caller appears.
 */
const HELPER_ONLY_EVENTS = new Set([
  'team_landing_gallery_view',
  'team_landing_open',
  'team_library_batch_completed',
  'team_library_processing_completed',
  'team_task_completed'
]);

function hasProducer(event: string): boolean {
  const quoted = `'${event}'`;
  return PRODUCER_SOURCES.some(source => source.includes(quoted));
}

describe('coverage registry · contract', () => {
  it('names only events the client contract declares (pending producers excepted)', () => {
    const unknown = registryEventNames().filter(
      event =>
        !CONTRACT_NAMES.has(event) &&
        !(PENDING_PRODUCER_EVENTS as readonly string[]).includes(event)
    );
    expect(unknown).toEqual([]);
  });

  it('lists as pending only names that are still absent from the contract, or notes they landed', () => {
    // Tolerated while the producer work is concurrent; once a name is in
    // `analyticsEventNames` it must still be a real event, never a typo.
    for (const name of PENDING_PRODUCER_EVENTS) {
      expect(typeof name).toBe('string');
      expect(name).toMatch(/^[a-z_]+$/);
    }
    const landed = PENDING_PRODUCER_EVENTS.filter(name => CONTRACT_NAMES.has(name));
    // Every landed name must also be referenced by the registry — otherwise the
    // list carries dead weight.
    for (const name of landed) expect(registryEventNames()).toContain(name);
  });

  it('has unique capability ids, stage evidence inside its stages, and known tool columns', () => {
    const ids = COVERAGE_REGISTRY.map(capability => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of COVERAGE_REGISTRY) {
      expect(capability.stages.length).toBeGreaterThan(0);
      for (const stage of Object.keys(capability.stageEvents)) {
        expect(capability.stages, `${capability.id}.stageEvents.${stage}`).toContain(stage);
      }
      if (capability.toolColumn) {
        expect(ANALYTICS_TOOLS as readonly string[]).toContain(capability.toolColumn);
      }
      expect(capability.platforms.length).toBeGreaterThan(0);
      if (capability.source === 'events' && capability.producerStatus === 'emitted') {
        expect(capabilitySignals(capability).length, capability.id).toBeGreaterThan(0);
      }
    }
  });

  it('marks a signal `emitted` only when a call site in the web or shared source tracks it', () => {
    const emittedWithoutProducer: string[] = [];
    for (const capability of COVERAGE_REGISTRY) {
      for (const signal of capabilitySignals(capability)) {
        if (signalStatus(capability, signal) === 'emitted' && !hasProducer(signal.event)) {
          emittedWithoutProducer.push(`${capability.id}:${signal.event}`);
        }
      }
    }
    // Stage evidence inherits its capability's status; it needs a producer too.
    for (const [event, status] of registryEventStatuses()) {
      if (status === 'emitted' && !hasProducer(event))
        emittedWithoutProducer.push(`stage:${event}`);
    }
    expect(emittedWithoutProducer).toEqual([]);
  });

  it('does not call a signal unsupported or pending when a call site already emits it', () => {
    const producedButNotEmitted: string[] = [];
    for (const [event, status] of registryEventStatuses()) {
      if (status !== 'emitted' && !HELPER_ONLY_EVENTS.has(event) && hasProducer(event)) {
        producedButNotEmitted.push(event);
      }
    }
    expect(producedButNotEmitted).toEqual([]);
  });
});

describe('coverage registry · CLI queries', () => {
  const source = readFileSync(resolve(ROOT, 'scripts/analytics/queries.ts'), 'utf8');
  const literalEvents = [
    ...new Set([...source.matchAll(/'([a-z][a-z0-9_]+)'/g)].map(m => m[1]))
  ].filter(token => CONTRACT_NAMES.has(token) || registryEventNames().includes(token));

  it('references in SQL only events the registry knows', () => {
    const registry = new Set(registryEventNames());
    const missing = literalEvents.filter(event => !registry.has(event));
    expect(missing).toEqual([]);
  });

  it('declares every literal event with a producer either as a metric input or as an audit probe', () => {
    // A literal without a producer may appear in a candidate list that the
    // registry filters out before SQL; one with a producer must be accounted for.
    const statuses = registryEventStatuses();
    const declared = new Set([
      ...QUERY_EVENT_NAMES,
      ...AUDIT_PROBE_EVENT_NAMES,
      ...DEFERRED_EVENT_NAMES
    ]);
    const undeclared = literalEvents.filter(
      event => statuses.get(event) === 'emitted' && !declared.has(event)
    );
    expect(undeclared).toEqual([]);
    // A deferred start is emitted today and waits only for its terminal.
    for (const event of DEFERRED_EVENT_NAMES) expect(statuses.get(event)).toBe('emitted');
  });

  it('computes metrics only from events with a producer, except the documented exceptions (SC-014)', () => {
    const statuses = registryEventStatuses();
    const declaredButNeverEmitted = QUERY_EVENT_NAMES.filter(
      event => statuses.get(event) !== 'emitted'
    );
    expect(declaredButNeverEmitted.sort()).toEqual([...KNOWN_DECLARED_BUT_NEVER_EMITTED].sort());
  });

  it('keeps QUERY_EVENT_NAMES sorted and unique so the audit output is deterministic', () => {
    expect([...QUERY_EVENT_NAMES]).toEqual([...new Set(QUERY_EVENT_NAMES)].sort());
  });
});
