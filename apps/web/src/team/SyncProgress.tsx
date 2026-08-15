import { useEffect, useState } from 'react';
import type { CatalogSearchResponse } from '@video-compressor/shared';
import { useI18n, type TranslationKey } from '../i18n';

type Freshness = CatalogSearchResponse['catalogFreshness'];

// No checkpoint in this long while a scan is still "scanning" reads as stuck
// rather than slow, so we swap the reassurance line for a "check the connection"
// hint. Replaying can legitimately be quiet, so the hint is scoped to scanning.
const STALL_THRESHOLD_MS = 90_000;

// Only the in-flight states render; ready/failed/unavailable resolve to null.
function activeHeading(state: Freshness['state']): TranslationKey | null {
  if (state === 'scanning') return 'teamSyncProgressScanning';
  if (state === 'replaying') return 'teamSyncProgressReplaying';
  if (state === 'not_started') return 'teamSyncProgressNotStarted';
  return null;
}

/**
 * Live, honest Drive-sync indicator. The scan is a breadth-first walk over a
 * tree whose size is unknown until it finishes, so there is no truthful
 * percentage to show. Instead this renders an indeterminate animated bar plus
 * the signals that actually prove liveness: how many items have been discovered
 * so far (unfiltered, so it moves even in a landings-only view), how many
 * folders remain queued, and how long ago the sync last made progress. The
 * "updated N ago" line ticks on its own timer so it keeps counting up between
 * server events — that upward count is what distinguishes "working" from
 * "stuck" for a member who is just watching.
 */
export function SyncProgress({
  freshness,
  variant = 'panel'
}: {
  freshness: Freshness;
  variant?: 'panel' | 'banner';
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const headingKey = activeHeading(freshness.state);
  const active = headingKey !== null;

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!headingKey) return null;

  const parsed = freshness.lastProgressAt ? Date.parse(freshness.lastProgressAt) : NaN;
  const ageMs = Number.isNaN(parsed) ? null : Math.max(0, now - parsed);
  const stalled = freshness.state === 'scanning' && ageMs !== null && ageMs > STALL_THRESHOLD_MS;
  const updatedLabel = ageMs === null ? null : formatUpdatedAgo(ageMs, t);
  const discoveredCount =
    typeof freshness.discoveredCount === 'number' && freshness.discoveredCount >= 0
      ? freshness.discoveredCount
      : 0;
  const foldersRemaining =
    typeof freshness.foldersRemaining === 'number' && freshness.foldersRemaining > 0
      ? freshness.foldersRemaining
      : null;

  return (
    <section
      className={`team-sync-progress team-sync-progress-${variant}`}
      aria-label={t('teamSyncProgressAria')}
    >
      <div className="team-sync-progress-head">
        <span className="team-sync-progress-spinner" aria-hidden="true" />
        <span className="team-sync-progress-heading">{t(headingKey)}</span>
      </div>
      <div
        className="team-sync-progress-bar"
        role="progressbar"
        aria-label={t('teamSyncProgressAria')}
      >
        <span className="team-sync-progress-bar-fill" />
      </div>
      <div className="team-sync-progress-stats">
        <span>{t('teamSyncProgressItems', { count: discoveredCount })}</span>
        {foldersRemaining !== null && (
          <span>{t('teamSyncProgressFolders', { count: foldersRemaining })}</span>
        )}
        {updatedLabel && <span className="team-sync-progress-updated">{updatedLabel}</span>}
      </div>
      <p className="team-sync-progress-note">
        {stalled ? t('teamSyncProgressStalled') : t('teamSyncProgressReassurance')}
      </p>
    </section>
  );
}

function formatUpdatedAgo(ageMs: number, t: ReturnType<typeof useI18n>['t']): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 5) return t('teamSyncProgressUpdatedJustNow');
  if (seconds < 60) return t('teamSyncProgressUpdatedSeconds', { count: seconds });
  const minutes = Math.round(seconds / 60);
  return t('teamSyncProgressUpdatedMinutes', { count: minutes });
}
