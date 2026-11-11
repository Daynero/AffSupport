import { useEffect, useState } from 'react';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { useOptionalTeam } from '../TeamContext';
import { withReadDeadline } from '../readCoordinator';
import { catalogTimeZoneCity } from './catalogTimeZones';

/** How often an unsettled publication is read again while the line is on screen. */
export const CATALOG_PUBLICATION_STATUS_POLL_MS = 15_000;

/** Nothing more will change on its own: published, held, or no job at all. */
function settled(snapshot: CatalogPublicationSnapshot): boolean {
  return snapshot.job === null || snapshot.job.state === 'published' || snapshot.mode === 'held';
}

/** A created table and its video-link publication are separate receipts.
 *
 * The line used to be read once, when the result appeared, and then kept saying
 * «заплановано на 20:20» after the creation was canceled and the publication held,
 * and after 19:42 had passed while the videos were still being made (1.4.3 QA).
 * It now reads again whenever the creation's video state moves (`refresh`) and,
 * while the publication is still pending, every 15 seconds — and judges "overdue"
 * by the server's clock carried forward, not by the moment of the first read. */
export function CatalogCreatedPublicationStatus({
  teamId,
  catalogId,
  read = teamApi.readCatalogPublication,
  refresh = '',
  videoCanceled = false
}: {
  teamId: string;
  catalogId: string;
  read?: typeof teamApi.readCatalogPublication;
  /** Changes whenever the creation's video state changes; each change reads again. */
  refresh?: string;
  /** The creation's video generation was canceled, so a held publication is final. */
  videoCanceled?: boolean;
}) {
  const { t, language } = useI18n(),
    epoch = usePrivateCacheEpoch(),
    actor = privateCacheActor(),
    workspace = useOptionalTeam();
  const scope = `${actor}:${epoch}:${teamId}:${catalogId}`;
  const [observation, setObservation] = useState<{
    scope: string;
    snapshot: CatalogPublicationSnapshot | null;
    observedAt: number;
    unknown: boolean;
  }>({ scope, snapshot: null, observedAt: 0, unknown: false });
  const [poll, setPoll] = useState(0);
  const snapshot = observation.scope === scope ? observation.snapshot : null,
    unknown = observation.scope === scope && observation.unknown;
  useEffect(() => {
    const controller = new AbortController();
    // A new catalog starts blank; a re-read of the same one keeps the line it has.
    setObservation(current =>
      current.scope === scope ? current : { scope, snapshot: null, observedAt: 0, unknown: false }
    );
    if (!actor) return;
    void withReadDeadline(
      signal => read(teamId, catalogId, undefined, { signal }),
      controller.signal
    )
      .then(value => {
        if (
          controller.signal.aborted ||
          privateCacheActor() !== actor ||
          privateCacheEpoch() !== epoch
        )
          return;
        setObservation({
          scope,
          snapshot: value,
          observedAt: performance.now(),
          unknown: value === null
        });
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          privateCacheActor() !== actor ||
          privateCacheEpoch() !== epoch
        )
          return;
        // A failed re-read says nothing new: keep the line already shown.
        setObservation(current =>
          current.scope === scope && current.snapshot
            ? current
            : { scope, snapshot: null, observedAt: 0, unknown: true }
        );
      });
    return () => controller.abort();
  }, [teamId, catalogId, actor, epoch, read, workspace?.updaterRevision, refresh, poll]);
  const pending = snapshot !== null && !settled(snapshot);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPoll(value => value + 1), CATALOG_PUBLICATION_STATUS_POLL_MS);
    return () => clearTimeout(timer);
  }, [pending, observation]);
  if (!snapshot)
    return unknown ? (
      <p role="status" className="catalog-publication-line">
        {t('catalogPublicationStatusUnknown')}
      </p>
    ) : null;
  let date = snapshot.dueAt ?? '';
  if (snapshot.dueAt)
    try {
      // The app's language and a 24-hour clock, as the time was entered; the browser's
      // locale gave "1:00 PM (Europe/Kiev)" to a Ukrainian-speaking team.
      const zone = snapshot.timeZone ?? 'UTC';
      const when = new Intl.DateTimeFormat(language, {
        dateStyle: 'medium',
        timeStyle: 'short',
        hourCycle: 'h23',
        timeZone: zone
      }).format(new Date(snapshot.dueAt));
      date = `${when} (${catalogTimeZoneCity(zone, t)})`;
    } catch {
      date = new Date(snapshot.dueAt).toISOString();
    }
  // The server's clock at the read, carried forward to now.
  const serverNow = snapshot.serverNow + Math.max(0, performance.now() - observation.observedAt);
  const due = snapshot.dueAt ? Date.parse(snapshot.dueAt) : Number.NaN;
  const published = snapshot.job?.state === 'published';
  const held = snapshot.mode === 'held' || snapshot.job?.state === 'held';
  // A due time that already passed without a verified write is not "scheduled" any more.
  // Videos still in the making say so at once; a plain write gets a minute's grace,
  // the time the server normally takes to publish.
  const reached =
    snapshot.mode === 'scheduled' && !published && Number.isFinite(due) && due <= serverNow;
  const waitingForVideos = reached && snapshot.targetObservation?.state === 'preparing';
  const overdue = reached && due + 60_000 <= serverNow;
  return (
    <>
      <p role="status" className="catalog-publication-line">
        {t(
          published
            ? 'catalogPublicationPreviouslyVerified'
            : held && videoCanceled
              ? 'catalogPublicationHeldVideoCanceled'
              : held
                ? 'catalogPublicationTableHeld'
                : waitingForVideos
                  ? 'catalogPublicationWaitingForVideos'
                  : overdue
                    ? 'catalogPublicationOverdue'
                    : snapshot.mode === 'scheduled'
                      ? 'catalogPublicationTableScheduled'
                      : 'catalogPublicationPending',
          { date }
        )}
      </p>
      {snapshot.providerCas === 'unsupported' &&
        snapshot.writerMode !== 'video_columns' &&
        !published && (
          <p role="status" className="team-inline-note">
            {t('catalogWriteUnsupported')}
          </p>
        )}
    </>
  );
}
