import { useState } from 'react';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { CatalogFixButton, catalogCodeMessage } from '../catalogFixActions';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { useOptionalTeam } from '../TeamContext';

export interface CatalogPublicationRetryClient {
  retryCatalogPublication?: typeof teamApi.retryCatalogPublication;
  changeCatalogPublication?: typeof teamApi.changeCatalogPublication;
}

/** A blocked reason that «Опублікувати ще раз» can move; the others have their own way out. */
const RETRYABLE = new Set(['target_unavailable', 'stale_job', 'job_blocked', 'clock_unavailable']);

/**
 * What a publication that stopped says, and the one thing to press (072).
 *
 * Production 2026-11-25: a job blocked as `target_unavailable` for a day after its Drive came
 * back, while the dialog kept saying «Публікуємо посилання…» and the creation's line said
 * nothing at all — a `blocked`, `retry_wait` or `unknown` job had no words on the page. Now each
 * says what happened; a blocked one offers «Опублікувати ще раз» (the same job back in the queue,
 * or a new immediate revision when the writer had already touched it), and one blocked because
 * the space lost Drive offers the way to reconnect it instead. `legacy_adoption_required` keeps
 * the dialog's own verification and is not shown here.
 */
export function CatalogPublicationBlockedNote({
  teamId,
  catalogId,
  snapshot,
  onRetried,
  client = {}
}: {
  teamId: string;
  catalogId: string;
  snapshot: CatalogPublicationSnapshot;
  /** The job went back into the queue (or a new revision was saved): read it again. */
  onRetried: () => void;
  client?: CatalogPublicationRetryClient;
}) {
  const { t } = useI18n();
  const space = useOptionalTeam();
  const [busy, setBusy] = useState(false);
  const [retried, setRetried] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: string | null; text: string } | null>(null);
  const job = snapshot.job;
  if (!job) return null;
  const driveState = space?.teams.find(team => team.id === teamId)?.connectionState;
  const driveLost = driveState !== undefined && driveState !== 'connected';

  // Just sent back by this note: say that, not «the first write failed».
  if (retried === job.id && ['waiting', 'preparing', 'retry_wait'].includes(job.state))
    return (
      <p role="status" className="team-inline-note">
        {t('catalogPublicationRetried')}
      </p>
    );
  if (job.state === 'unknown')
    return (
      <p role="status" className="team-inline-note">
        {t('catalogPublicationVerifyingWrite')}
      </p>
    );
  // `retry_wait` also means «the videos are not ready yet»; that wait is said elsewhere.
  if (job.state === 'retry_wait')
    return snapshot.targetObservation?.state === 'preparing' ? null : (
      <p role="status" className="team-inline-note">
        {t('catalogPublicationRetryWait')}
      </p>
    );
  if (job.state !== 'blocked' || job.blockedReason === 'legacy_adoption_required') return null;

  const reason = job.blockedReason ?? 'job_blocked';
  const message: TranslationKey =
    reason === 'writer_unsupported'
      ? 'catalogWriteUnsupported'
      : reason === 'invalid_due'
        ? 'catalogPublicationBlockedInvalidDue'
        : reason === 'target_unavailable'
          ? driveLost
            ? 'catalogPublicationBlockedDrive'
            : 'catalogPublicationBlockedTarget'
          : reason === 'stale_job'
            ? 'catalogPublicationBlockedStale'
            : 'catalogPublicationBlockedGeneric';
  const retryable = RETRYABLE.has(reason) && !(reason === 'target_unavailable' && driveLost);

  const retry = async () => {
    if (busy || retried === job.id) return;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await (client.retryCatalogPublication ?? teamApi.retryCatalogPublication)(
        teamId,
        catalogId,
        job.id
      );
      if (outcome === 'republish')
        await (client.changeCatalogPublication ?? teamApi.changeCatalogPublication)(teamId, {
          catalogId,
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.revision,
          action: 'add_now'
        });
      setRetried(job.id);
      onRetried();
    } catch (cause) {
      const code = teamErrorCodeOf(cause);
      setFailure({
        code,
        text:
          code === 'NEEDS_REAUTH' || code === 'SPACE_BLOCKED'
            ? catalogCodeMessage(code, t)
            : teamErrorMessageFor(cause, t)
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="catalog-publication-blocked" role="status">
      <p className="team-inline-note">
        {t(retried === job.id ? 'catalogPublicationRetried' : message)}
      </p>
      {retried !== job.id && (
        <div className="team-dialog-actions">
          {reason === 'target_unavailable' && driveLost && (
            <CatalogFixButton teamId={teamId} code="NEEDS_REAUTH" />
          )}
          {retryable && (
            <Button color="neutral" size="sm" loading={busy} onClick={() => void retry()}>
              {t('catalogPublicationRetry')}
            </Button>
          )}
        </div>
      )}
      {failure && (
        <>
          <p role="alert" className="team-inline-error">
            {failure.text}
          </p>
          <CatalogFixButton teamId={teamId} code={failure.code} />
        </>
      )}
    </div>
  );
}
