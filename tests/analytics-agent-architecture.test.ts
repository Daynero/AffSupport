// @vitest-environment jsdom
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductAnalytics, type PendingAnalyticsEvent } from '../apps/web/src/analytics/service';
import { sanitizeAnalyticsProperties } from '../apps/web/src/analytics/events';
import { getCohorts } from '../scripts/analytics/queries';
import { setQueryExecutor } from '../scripts/analytics/db';
import { resolvePeriod } from '../scripts/analytics/periods';

afterEach(() => setQueryExecutor(null));
describe('native architecture producer → guard → stored properties → CLI', () => {
  it('does not turn an installer request or caller metadata into observed native identity', async () => {
    const captured: PendingAnalyticsEvent[] = [];
    const client = new ProductAnalytics(async events => {
      captured.push(...events);
      return { acceptedEventIds: events.map(event => event.event_id) };
    }, null);
    client.setUser('00000000-0000-4000-8000-000000000001');
    client.track('install_download_clicked', {
      installer_target: 'macos-x64',
      package_target: 'macos-x64',
      agent_architecture: 'x64',
      native_startup_id: '00000000-0000-4000-8000-000000000003'
    });
    await client.flush();
    expect(captured[0].properties).toEqual({ installer_target: 'macos-x64' });
    expect(captured[0].agent_instance_id).toBeNull();
    client.setAgentContext({
      version: '1.3.3',
      buildId: '1.3.3+79',
      channel: 'stable',
      apiVersion: 6,
      toolContracts: {},
      instanceId: '00000000-0000-4000-8000-000000000002',
      platform: 'macos',
      architecture: 'arm64',
      packageTarget: 'macos-arm64',
      nativeStartupId: '00000000-0000-4000-8000-000000000004'
    });
    client.track('install_download_clicked', {
      installer_target: 'macos-x64',
      package_target: 'macos-x64',
      agent_architecture: 'x64'
    });
    await client.flush();
    expect(captured[1].properties).toMatchObject({
      installer_target: 'macos-x64',
      package_target: 'macos-arm64',
      agent_architecture: 'arm64',
      native_startup_id: '00000000-0000-4000-8000-000000000004'
    });
  });
  it('keeps browser identity independent and separates Windows x64 from Intel Mac', async () => {
    const db = await PGlite.create();
    try {
      const migration = await readFile(
        'supabase/migrations/20261207190000_agent_native_identity_analytics.sql',
        'utf8'
      );
      const guard =
        /create or replace function public\.analytics_properties_are_safe_v2\s*\(payload jsonb\)[\s\S]*?\$\$;/.exec(
          migration
        )?.[0];
      expect(guard).toBeTruthy();
      await db.exec(guard!);
      await db.exec(
        'create table analytics_events (user_id text,event_name text,occurred_at timestamptz,created_at timestamptz,agent_platform text,local_app_build text,properties jsonb)'
      );
      for (const platform of ['macos', 'windows'] as const) {
        const captured: PendingAnalyticsEvent[] = [];
        const client = new ProductAnalytics(async events => {
          captured.push(...events);
          return { acceptedEventIds: events.map(e => e.event_id) };
        }, null);
        client.setUser('00000000-0000-4000-8000-000000000001');
        client.setAgentContext({
          version: '1.3.3',
          buildId: '1.3.3+79',
          channel: 'stable',
          apiVersion: 6,
          toolContracts: {},
          instanceId: '00000000-0000-4000-8000-000000000002',
          platform,
          packageTarget: platform === 'macos' ? 'macos-x64' : 'windows-x64',
          nativeStartupId: platform === 'macos' ? '00000000-0000-4000-8000-000000000003' : null,
          architecture: 'x64'
        });
        client.track('compression_completed', {});
        client.track('team_workspace_session', {});
        await client.flush();
        const teamEvent = captured.find(e => e.event_name === 'team_workspace_session')!;
        const reloaded = sanitizeAnalyticsProperties(
          JSON.parse(JSON.stringify(teamEvent.properties)),
          'team_workspace_session'
        );
        expect(reloaded).toEqual(teamEvent.properties);
        expect(
          (
            await db.query<{ ok: boolean }>(
              'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
              [JSON.stringify(reloaded)]
            )
          ).rows[0].ok
        ).toBe(true);
        const event = captured.find(e => e.event_name === 'compression_completed')!;
        if (platform === 'macos')
          expect(event.properties.native_startup_id).toBe('00000000-0000-4000-8000-000000000003');
        else expect(event.properties).not.toHaveProperty('native_startup_id');
        expect(event.properties).toMatchObject({
          agent_architecture: 'x64',
          package_target: platform === 'macos' ? 'macos-x64' : 'windows-x64'
        });
        const safe = await db.query<{ ok: boolean }>(
          'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
          [JSON.stringify(event.properties)]
        );
        expect(safe.rows[0].ok).toBe(true);
        await db.query('insert into analytics_events values ($1,$2,$3,$3,$4,$5,$6)', [
          event.user_id,
          event.event_name,
          event.occurred_at,
          event.agent_platform,
          event.local_app_build,
          JSON.stringify(event.properties)
        ]);
      }
      const downloads: PendingAnalyticsEvent[] = [];
      const fresh = new ProductAnalytics(async events => {
        downloads.push(...events);
        return { acceptedEventIds: events.map(event => event.event_id) };
      }, null);
      fresh.setUser('00000000-0000-4000-8000-000000000001');
      fresh.track('install_download_clicked', { installer_target: 'macos-x64' });
      await fresh.flush();
      const download = downloads[0];
      expect(download.properties).toEqual({ installer_target: 'macos-x64' });
      expect(
        (
          await db.query<{ ok: boolean }>(
            'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
            [JSON.stringify(download.properties)]
          )
        ).rows[0].ok
      ).toBe(true);
      await db.query('insert into analytics_events values ($1,$2,$3,$3,$4,$5,$6)', [
        download.user_id,
        download.event_name,
        download.occurred_at,
        download.agent_platform,
        download.local_app_build,
        JSON.stringify(download.properties)
      ]);
      setQueryExecutor(async (sql, params) => {
        if (sql.includes('information_schema')) return [{ kind: 'column', name: 'agent_platform' }];
        return (await db.query<Record<string, unknown>>(sql, params)).rows;
      });
      const cohorts = await getCohorts(resolvePeriod('all', undefined), 'agent-architecture');
      expect(cohorts.map(c => c.cohort).sort()).toEqual([
        'macos:x64:1.3.3+79',
        'unknown:unknown:unknown',
        'windows:x64:1.3.3+79'
      ]);
      expect(
        sanitizeAnalyticsProperties({
          agent_architecture: '/Users/private',
          package_target: 'secret',
          native_startup_id: 'raw-user-content'
        })
      ).toEqual({});
      const unsafe = await db.query<{ ok: boolean }>(
        'select public.analytics_properties_are_safe_v2($1::jsonb) as ok',
        [JSON.stringify({ agent_architecture: 'secret' })]
      );
      expect(unsafe.rows[0].ok).toBe(false);
    } finally {
      await db.close();
    }
  }, 30000);
});
