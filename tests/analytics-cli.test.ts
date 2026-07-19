import { describe, expect, it } from 'vitest';
import { assertReadOnlySql } from '../scripts/analytics/db';
import { resolvePeriod } from '../scripts/analytics/periods';
import { formatBytes } from '../scripts/analytics/format';

describe('resolvePeriod', () => {
  it('defaults to a rolling 7-day window', () => {
    const period = resolvePeriod(undefined, undefined);
    expect(period.token).toBe('7d');
    expect(period.start).not.toBeNull();
    const spanDays =
      (Date.parse(period.end) - Date.parse(period.start as string)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(7, 1);
  });

  it('treats "all" as having no lower bound', () => {
    const period = resolvePeriod('all', undefined);
    expect(period.start).toBeNull();
    expect(period.token).toBe('all');
  });

  it('honours --days over --period', () => {
    const period = resolvePeriod('30d', 3);
    expect(period.token).toBe('3d');
    const spanDays =
      (Date.parse(period.end) - Date.parse(period.start as string)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(3, 1);
  });

  it('starts "today" at UTC midnight', () => {
    const period = resolvePeriod('today', undefined);
    expect(period.start).not.toBeNull();
    expect((period.start as string).slice(11)).toBe('00:00:00.000Z');
  });

  it('rejects unknown tokens and non-positive days', () => {
    expect(() => resolvePeriod('yesterday', undefined)).toThrow();
    expect(() => resolvePeriod(undefined, 0)).toThrow();
    expect(() => resolvePeriod(undefined, -5)).toThrow();
  });
});

describe('assertReadOnlySql', () => {
  it('accepts single SELECT and WITH statements', () => {
    expect(() => assertReadOnlySql('select count(*) from public.analytics_events')).not.toThrow();
    expect(() => assertReadOnlySql('with x as (select 1) select * from x')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT 1;')).not.toThrow(); // trailing semicolon allowed
  });

  it('rejects write and DDL statements', () => {
    for (const sql of [
      "insert into public.analytics_events (event_name) values ('x')",
      'update public.profiles set plan = $1',
      'delete from public.analytics_events',
      'drop table public.analytics_events',
      'alter table public.profiles add column x int',
      'truncate public.analytics_events',
      'create table t (id int)',
      'grant select on t to public'
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow();
    }
  });

  it('rejects multi-statement SQL', () => {
    expect(() => assertReadOnlySql('select 1; drop table public.analytics_events')).toThrow();
  });
});

describe('formatBytes', () => {
  it('renders human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
  });
});
