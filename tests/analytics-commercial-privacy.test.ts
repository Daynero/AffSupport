import { afterAll, beforeAll, expect, it } from 'vitest';
import { createAnalyticsDb, type AnalyticsTestDb } from './support/analytics-pglite';
import { CommandError, executeCommand, parseArgs } from '../scripts/analytics/cli';
import {
  investigateOutputIsPrivate,
  investigatePrivacyFailure,
  type InvestigateData
} from '../scripts/analytics/types';

let db: AnalyticsTestDb;
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeAll(async () => {
  db = await createAnalyticsDb();
  await db.exec(`
    insert into analytics_users (id, email_normalized) values ('${USER}', 'fixture@example.test');
    create table analytics_commercial_access (
      id uuid, owner_id uuid, team_id uuid, kind text, observed_at timestamptz,
      needs_review boolean, principal_bound boolean, seats_used integer, seats_total integer
    );
    insert into analytics_commercial_access values (
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${USER}', null,
      'migration_capacity_review', '2026-10-08T12:00:00Z', true, false, 4, 3
    );
  `);
}, 30_000);
afterAll(async () => {
  await db.close();
});

it('passes the complete investigation through privacy validation with the installed commercial projection and a review finding', async () => {
  const result = await executeCommand(
    parseArgs(['investigate', 'fixture@example.test', '--as-of', '2026-10-09T00:00:00Z'])
  );
  const data = result.data as InvestigateData;
  expect(data.commercial_access).toMatchObject({
    supported: true,
    records: [{ needs_review: true }]
  });
  expect(data.findings.some(finding => finding.rule === 'commercial_access_review_observed')).toBe(
    true
  );
  expect(investigatePrivacyFailure(data)).toBeNull();
  expect(investigateOutputIsPrivate(data)).toBe(true);
  expect(JSON.stringify(data)).not.toContain('fixture@example.test');
});

it('reports a safe category on privacy failure without exposing the rejected record', async () => {
  await db.exec("update analytics_commercial_access set kind='OAuth private-secret'");
  try {
    const error = await executeCommand(
      parseArgs(['investigate', 'fixture@example.test', '--as-of', '2026-10-09T00:00:00Z'])
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({
      message: 'Investigation output failed its privacy guard.',
      hint: 'Privacy category: credential.'
    });
    expect(JSON.stringify(error)).not.toContain('private-secret');
  } finally {
    await db.exec("update analytics_commercial_access set kind='migration_capacity_review'");
  }
});

it('also accepts an installed commercial projection without matching records', async () => {
  const result = await executeCommand(
    parseArgs(['investigate', 'fixture@example.test', '--as-of', '2026-10-01T00:00:00Z'])
  );
  expect((result.data as InvestigateData).commercial_access).toMatchObject({
    supported: true,
    records: []
  });
  expect(investigateOutputIsPrivate(result.data)).toBe(true);
});

it('returns only closed privacy failure categories and continues rejecting secrets and paths', () => {
  for (const [value, category] of [
    [{ email: 'hidden' }, 'forbidden_key'],
    [{ secret_key_name: ['person@example.test'] }, 'address'],
    [{ nested: { value: 'https://secret.example' } }, 'url'],
    [{ value: 'C:\\Users\\private' }, 'path'],
    [{ value: 'OAuth secret' }, 'credential'],
    [{ value: 'Bearer secret' }, 'credential'],
    [{ value: 'token=secret' }, 'credential'],
    [{ files: ['apps/../secret'] }, 'invalid_source_file']
  ] as const) {
    expect(investigatePrivacyFailure(value)).toBe(category);
    expect(investigateOutputIsPrivate(value)).toBe(false);
  }
  expect(investigateOutputIsPrivate({ files: ['apps/agent/src/index.ts'] })).toBe(true);
});

it('allows the known native Mac source file without allowing arbitrary packaging paths', () => {
  expect(investigateOutputIsPrivate({ files: ['packaging/Launcher.swift'] })).toBe(true);
  for (const file of [
    'packaging/../private.swift',
    '/private/Launcher.swift',
    'packaging/NotApproved.swift',
    'packaging/Launcher.swift/..'
  ]) {
    expect(investigateOutputIsPrivate({ files: [file] }), file).toBe(false);
  }
});
