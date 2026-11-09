import { useEffect, useState } from 'react';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n } from '../../i18n';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { useOptionalTeam } from '../TeamContext';
import { withReadDeadline } from '../readCoordinator';
/** A created table and its video-link publication are separate receipts. */
export function CatalogCreatedPublicationStatus({
  teamId,
  catalogId,
  read = teamApi.readCatalogPublication
}: {
  teamId: string;
  catalogId: string;
  read?: typeof teamApi.readCatalogPublication;
}) {
  const { t } = useI18n(),
    epoch = usePrivateCacheEpoch(),
    actor = privateCacheActor(),
    workspace = useOptionalTeam();
  const scope = `${actor}:${epoch}:${teamId}:${catalogId}`;
  const [observation, setObservation] = useState<{
    scope: string;
    snapshot: CatalogPublicationSnapshot | null;
    unknown: boolean;
  }>({ scope, snapshot: null, unknown: false });
  const snapshot = observation.scope === scope ? observation.snapshot : null,
    unknown = observation.scope === scope && observation.unknown;
  useEffect(() => {
    const controller = new AbortController();
    setObservation({ scope, snapshot: null, unknown: false });
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
        setObservation({ scope, snapshot: value, unknown: value === null });
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          privateCacheActor() === actor &&
          privateCacheEpoch() === epoch
        )
          setObservation({ scope, snapshot: null, unknown: true });
      });
    return () => controller.abort();
  }, [teamId, catalogId, actor, epoch, read, workspace?.updaterRevision]);
  if (!snapshot)
    return unknown ? <p role="status">{t('catalogPublicationStatusUnknown')}</p> : null;
  let date = snapshot.dueAt ?? '';
  if (snapshot.dueAt)
    try {
      date = `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: snapshot.timeZone ?? 'UTC' }).format(new Date(snapshot.dueAt))} (${snapshot.timeZone ?? 'UTC'})`;
    } catch {
      date = new Date(snapshot.dueAt).toISOString();
    }
  // A due time that already passed without a verified write is not "scheduled" any more.
  const overdue =
    snapshot.mode === 'scheduled' &&
    snapshot.job?.state !== 'published' &&
    Boolean(snapshot.dueAt) &&
    Date.parse(snapshot.dueAt!) < snapshot.serverNow - 60_000;
  return (
    <>
      <p role="status">
        {t(
          snapshot.job?.state === 'published'
            ? 'catalogPublicationPreviouslyVerified'
            : overdue && snapshot.targetObservation?.state === 'preparing'
              ? 'catalogPublicationWaitingForVideos'
              : overdue
                ? 'catalogPublicationOverdue'
                : snapshot.mode === 'scheduled'
                  ? 'catalogPublicationTableScheduled'
                  : snapshot.mode === 'held'
                    ? 'catalogPublicationTableHeld'
                    : 'catalogPublicationPending',
          { date }
        )}
      </p>
      {snapshot.providerCas === 'unsupported' &&
        snapshot.writerMode !== 'video_columns' &&
        snapshot.job?.state !== 'published' && (
          <p role="status" className="team-inline-note">
            {t('catalogWriteUnsupported')}
          </p>
        )}
    </>
  );
}
