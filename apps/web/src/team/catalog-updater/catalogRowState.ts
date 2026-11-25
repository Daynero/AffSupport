import { useMemo } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import { matchesCatalogCreatedAt } from './catalogCreatedDate';
import { filterCatalogRows } from './useCatalogUpdater';
import { catalogRowActivity, needsVideo } from './catalogRowActivity';

/**
 * What a row of the catalog manager says about itself, out of the dialog (070, T056) so the
 * list, its filters and its rows read the same answers.
 */

export function lastSuccess(row: CatalogRegistryRow): string | null {
  return row.profile?.lastSuccessfulAt === undefined
    ? row.lastUpdatedAt
    : row.profile.lastSuccessfulAt;
}

export { needsVideo };

export function needsAttention(row: CatalogRegistryRow, now = Date.now()) {
  if (row.profile?.reconciliationRequired) return row.profile.lastResult !== 'running';
  // Work under way needs a person only when it stands on something (072, П5: an error between
  // retries, a computer that never took the round, a refused re-stitch).
  const activity = catalogRowActivity(row, now);
  if (activity.active) return activity.motion === 'problem' || activity.motion === 'stalled';
  return Boolean(
    row.lastUpdateError ||
    ['failed', 'partial', 'unknown'].includes(row.profile?.lastResult ?? '') ||
    (needsVideo(row) && row.profile?.restitchStatus === 'blocked')
  );
}

export type CatalogStatusFilter = 'all' | 'scheduled' | 'off' | 'updating' | 'failed' | 'never';
export type CatalogRecencyFilter = 'all' | 'day' | 'week' | 'older' | 'never';
export type CatalogSort = 'created' | 'createdAsc' | 'last' | 'next';

export interface CatalogListView {
  query: string;
  status: string;
  recency: string;
  sortBy: string;
  createdRange: { from: string; to: string };
}

const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

/** The list as it is shown: the search, the filters, then the order. */
export function shownCatalogRows(
  rows: readonly CatalogRegistryRow[],
  view: CatalogListView,
  now = Date.now()
): CatalogRegistryRow[] {
  const age = (row: CatalogRegistryRow) => {
    const at = lastSuccess(row);
    return at ? now - Date.parse(at) : null;
  };
  return filterCatalogRows(rows, view.query)
    .filter(row => {
      if (!matchesCatalogCreatedAt(row.createdAt, view.createdRange)) return false;
      if (view.status === 'scheduled' && row.updateInterval === null) return false;
      if (view.status === 'off' && row.updateInterval !== null) return false;
      if (view.status === 'updating' && !row.updatePending) return false;
      if (view.status === 'failed' && !needsAttention(row)) return false;
      if (view.status === 'never' && lastSuccess(row) !== null) return false;
      const since = age(row);
      if (view.recency === 'never' && since !== null) return false;
      if (view.recency === 'day' && (since === null || since > DAY_MS)) return false;
      if (view.recency === 'week' && (since === null || since > WEEK_MS)) return false;
      if (view.recency === 'older' && (since === null || since <= WEEK_MS)) return false;
      return true;
    })
    .sort((a, b) => {
      const field =
        view.sortBy === 'last'
          ? 'lastUpdatedAt'
          : view.sortBy === 'next'
            ? 'nextRunAt'
            : 'createdAt';
      const left = (view.sortBy === 'last' ? lastSuccess(a) : a[field]) ?? '';
      const right = (view.sortBy === 'last' ? lastSuccess(b) : b[field]) ?? '';
      return view.sortBy === 'next' || view.sortBy === 'createdAsc'
        ? left.localeCompare(right) || a.catalogId.localeCompare(b.catalogId)
        : right.localeCompare(left) || a.catalogId.localeCompare(b.catalogId);
    });
}

/** A long catalog name, split where the eye needs it: the video's stem and its `_vN` tail. */
export function catalogNameParts(name: string): [string, string] {
  const match = /^(.*?)(_v\d+.*)$/iu.exec(name);
  return match
    ? [match[1]!, match[2]!]
    : name.length > 42
      ? [name.slice(0, -16), name.slice(-16)]
      : [name, ''];
}

/** The manager's three ways of writing a date: full with the zone, a short stamp, a day. */
export function useCatalogDates(language: string) {
  const locale = language === 'uk' ? 'uk-UA' : 'en-US';
  const shortLocale = language === 'uk' ? 'uk-UA' : 'en-GB';
  const full = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  );
  const createdDateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(shortLocale, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    [shortLocale]
  );
  const stamp = useMemo(
    () =>
      new Intl.DateTimeFormat(shortLocale, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }),
    [shortLocale]
  );
  return {
    when: (iso: string) =>
      `${full.format(new Date(iso))} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    shortWhen: (iso: string) => stamp.format(new Date(iso)),
    createdDateFormat
  };
}
