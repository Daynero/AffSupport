import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { resolvePeriod } from '../scripts/analytics/periods';
import {
  featureUnsupportedSignals,
  getCohorts,
  getFriction,
  getOnboarding,
  getUpdates
} from '../scripts/analytics/queries';
import {
  isUnsupported,
  NO_AGENT_CONTEXT_COHORT,
  type ResolvedPeriod
} from '../scripts/analytics/types';
import { formatFriction, formatStages } from '../scripts/analytics/format';

/**
 * 031 T007 — a signal nobody emits is reported as `unsupported_by_producer`,
 * never as a zero. The producer facts come from the coverage registry.
 */

let db: AnalyticsTestDb;
let ALL: ResolvedPeriod;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into public.analytics_events (user_id, event_name, session_id, tool, properties, local_app_version, platform, occurred_at) values
      ('${USER}','update_available','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:00Z'),
      ('${USER}','update_prompt_shown','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:01Z'),
      ('${USER}','update_started','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:02Z'),
      ('${USER}','setup_prompt_shown','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:03Z'),
      ('${USER}','install_download_clicked','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:04Z'),
      ('${USER}','tool_opened','${SESSION}','compressor','{"tool_identifier":"compressor"}','1.2.5','macos','2026-10-01T10:00:05Z'),
      ('${USER}','videos_added','${SESSION}','compressor','{"video_count":1}','1.2.5','macos','2026-10-01T10:00:06Z'),
      ('${USER}','compression_started','${SESSION}','compressor','{}','1.2.5','macos','2026-10-01T10:00:07Z'),
      ('${USER}','compression_completed','${SESSION}','compressor','{}','1.2.5','macos','2026-10-01T10:00:08Z'),
      ('${USER}','home_viewed','${SESSION}',null,'{}',null,'macos','2026-10-01T10:00:09Z');
  `);
  ALL = resolvePeriod('all', undefined);
}, 30_000);

afterAll(async () => {
  await db.close();
});

describe('updates', () => {
  it('counts the browser-side stages and marks every agent-side stage unsupported', async () => {
    const rows = await getUpdates(ALL);
    const counted = rows.filter(row => !isUnsupported(row)).map(row => row.stage);
    expect(counted).toEqual(['update_available', 'update_prompt_shown', 'update_started']);
    const unsupported = rows.filter(isUnsupported).map(row => row.stage);
    expect(unsupported).toEqual([
      'update_completed',
      'update_deferred_busy',
      'update_download_completed',
      'update_draining_started',
      'update_failed',
      'update_restart_started',
      'update_verification_failed'
    ]);
    for (const row of rows.filter(isUnsupported)) {
      expect(row).toMatchObject({ status: 'unsupported_by_producer', events: [row.stage] });
      expect(row).not.toHaveProperty('events_count');
      expect(row).not.toHaveProperty('users');
    }
    expect(formatStages('Updates', { stages: rows }, ALL)).toContain('unsupported by producer');
  });
});

describe('onboarding', () => {
  it('reports the legacy pairing and install names as unsupported, not as zero', async () => {
    const rows = await getOnboarding(ALL);
    const counted = rows.filter(row => !isUnsupported(row));
    expect(counted.map(row => row.stage)).toEqual([
      'setup_prompt_shown',
      'install_download_clicked'
    ]);
    const unsupported = rows.filter(isUnsupported).map(row => row.stage);
    expect(unsupported).toEqual(
      expect.arrayContaining([
        'install_detected',
        'local_app_check_started',
        'local_app_check_completed',
        'local_app_launch_clicked',
        'onboarding_started',
        'onboarding_skipped',
        'onboarding_step_completed'
      ])
    );
    // onboarding_completed does have a producer (AuthContext) — it is counted, not unsupported.
    expect(unsupported).not.toContain('onboarding_completed');
    // blocked_action_attempted is emitted; it simply did not happen in this fixture.
    expect(unsupported).not.toContain('blocked_action_attempted');
  });
});

describe('friction', () => {
  it('replaces update_not_completed with an unsupported signal while update_completed has no producer', async () => {
    const rows = await getFriction(ALL);
    const update = rows.find(row => row.signal === 'update_not_completed');
    expect(update).toBeDefined();
    expect(isUnsupported(update)).toBe(true);
    expect(update).toMatchObject({ events: ['update_completed'] });
    // The compressor session reached an outcome: no false friction.
    expect(rows.filter(row => !isUnsupported(row)).map(row => row.signal)).toEqual([]);
    expect(formatFriction({ signals: rows }, ALL)).toContain('update_not_completed');
  });
});

describe('features', () => {
  it('lists the interaction events without a producer', () => {
    const signals = featureUnsupportedSignals().map(row => row.signal);
    expect(signals).toEqual(['feature_disabled', 'feature_help_opened']);
  });
});

describe('cohorts', () => {
  it('names the browser-only rows no_agent_context for local-app-version, unknown elsewhere', async () => {
    const byVersion = await getCohorts(ALL, 'local-app-version');
    expect(byVersion.map(row => row.cohort).sort()).toEqual(['1.2.5', NO_AGENT_CONTEXT_COHORT]);
    expect(byVersion.find(row => row.cohort === '1.2.5')).toMatchObject({
      successes: 1,
      failures: 0
    });
    expect(byVersion.map(row => row.cohort)).not.toContain('unknown');

    const byBuild = await getCohorts(ALL, 'web-build');
    expect(byBuild.map(row => row.cohort)).toEqual(['unknown']);
  });
});
