import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateAttempt } from '@video-compressor/shared';
import { Button } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

const STAGE_LABELS = {
  preparing: 'catalogUpdaterStagePreparing',
  refreshing: 'catalogUpdaterStageRefreshing',
  building: 'catalogUpdaterStageBuilding',
  uploading: 'catalogUpdaterStageUploading',
  verifying: 'catalogUpdaterStageVerifying',
  finalizing: 'catalogUpdaterStageFinalizing'
} as const satisfies Record<
  NonNullable<CatalogUpdateAttempt['stages']>[number]['stage'],
  TranslationKey
>;

export function CatalogStatusDetails({
  teamId,
  catalogId,
  currentProfileVersion,
  load,
  onClose,
  onRetry,
  checkingDelivery = false,
  retryDisabled = false
}: {
  teamId: string;
  catalogId: string;
  currentProfileVersion?: number;
  load: (teamId: string, catalogId: string) => Promise<CatalogUpdateAttempt[]>;
  onClose: () => void;
  onRetry?: (sourceAttemptId: string) => Promise<void> | void;
  retryDisabled?: boolean;
  checkingDelivery?: boolean;
}) {
  const { t, language } = useI18n();
  const [attempts, setAttempts] = useState<CatalogUpdateAttempt[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retryLock = useRef(false);
  const retry = async (attemptId: string) => {
    if (!onRetry || retryDisabled || retryLock.current) return;
    retryLock.current = true;
    setRetryPending(true);
    setRetryError(null);
    try {
      await onRetry(attemptId);
      setAttempts(null);
      setRevision(value => value + 1);
    } catch (cause) {
      setRetryError(teamErrorMessageFor(cause, t));
    } finally {
      retryLock.current = false;
      setRetryPending(false);
    }
  };
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      void load(teamId, catalogId)
        .then(rows => {
          if (active) {
            setAttempts(rows);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const timer = checkingDelivery ? window.setInterval(refresh, 5000) : null;
    return () => {
      if (timer !== null) window.clearInterval(timer);
      active = false;
    };
  }, [teamId, catalogId, load, revision, checkingDelivery]);
  const date = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  const when = (iso: string) => date.format(new Date(iso));
  const orderedAttempts = attempts
    ? [...attempts].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    : null;
  const latest = orderedAttempts?.[0];
  const retrySource =
    latest && (latest.result === 'failed' || latest.result === 'partial') ? latest : null;
  return (
    <div className="team-updater-profile" role="group" aria-label={t('catalogUpdaterHistory')}>
      <div className="team-updater-profile-actions">
        <strong>{t('catalogUpdaterHistory')}</strong>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('catalogUpdaterClose')}
        </Button>
      </div>
      {error && (
        <div role="alert" className="team-inline-error">
          {t('catalogUpdaterHistoryFailed')}{' '}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setRevision(value => value + 1)}
          >
            {t('catalogUpdaterRetry')}
          </Button>
        </div>
      )}
      {!error && attempts === null && <p>{t('catalogUpdaterLoading')}</p>}
      {attempts?.length === 0 && <p>{t('catalogUpdaterHistoryEmpty')}</p>}
      {checkingDelivery && latest?.result === 'running' && (
        <p className="field-hint">{t('catalogDeliveryCheckingHint')}</p>
      )}
      {attempts && attempts.length > 0 && (
        <ol className="team-updater-history">
          {orderedAttempts?.map(attempt => (
            <li key={attempt.attemptId}>
              <span>{when(attempt.startedAt)}</span>
              {' · '}
              <span>
                {attempt.trigger === 'manual'
                  ? t('catalogUpdaterManual')
                  : attempt.trigger === 'schedule'
                    ? t('catalogUpdaterScheduled')
                    : attempt.trigger === 'retry'
                      ? t('catalogUpdaterRetryNow')
                      : t('catalogUpdaterUnknownTrigger')}
              </span>
              {' · '}
              <strong>
                {checkingDelivery && attempt === latest && attempt.result === 'running'
                  ? t('catalogDeliveryChecking')
                  : t(
                      `catalogUpdaterResult_${attempt.result}` as
                        | 'catalogUpdaterResult_running'
                        | 'catalogUpdaterResult_success'
                        | 'catalogUpdaterResult_partial'
                        | 'catalogUpdaterResult_failed'
                        | 'catalogUpdaterResult_cancelled'
                        | 'catalogUpdaterResult_unknown'
                    )}
              </strong>
              {attempt.endedAt && (
                <span> · {t('catalogUpdaterEndedAt', { date: when(attempt.endedAt) })}</span>
              )}
              {attempt.deliveryVerifiedAt && attempt.actualChanges && (
                <p className="field-hint">
                  {t('catalogUpdaterActualChanges', {
                    changes:
                      [
                        attempt.actualChanges.productIds && t('catalogUpdaterIds'),
                        attempt.actualChanges.linksVaried && t('catalogRandomLinkVariation'),
                        attempt.actualChanges.imagesRefreshed && t('catalogUpdaterRefreshImages'),
                        attempt.actualChanges.textsRefreshed && t('catalogUpdaterRefreshTexts'),
                        attempt.actualChanges.productsAdded && t('catalogUpdaterGrow'),
                        attempt.actualChanges.videoReplaced && t('catalogUpdaterRestitch')
                      ]
                        .filter(Boolean)
                        .join(', ') || t('catalogUpdaterNoActualEvidence')
                  })}
                </p>
              )}
              {attempt.result === 'partial' && (
                <p className="field-hint">
                  {attempt.deliveryVerifiedAt &&
                  attempt.profileSnapshot?.restitch &&
                  attempt.actualChanges?.videoReplaced === false
                    ? t('catalogUpdaterPartialVideo', {
                        date: when(attempt.deliveryVerifiedAt),
                        stage: attempt.stages?.at(-1)
                          ? t(STAGE_LABELS[attempt.stages.at(-1)!.stage])
                          : t('catalogUpdaterUnknownStage')
                      })
                    : t('catalogUpdaterPartialUnknown')}
                </p>
              )}
              {attempt.result === 'unknown' && (
                <p className="field-hint">
                  {t(
                    checkingDelivery && attempt === latest
                      ? 'catalogDeliveryUncertainHint'
                      : 'catalogUpdaterUnknownDelivery'
                  )}
                </p>
              )}
              <details>
                <summary>{t('catalogUpdaterDetails')}</summary>
                {attempt.stages && attempt.stages.length > 0 && (
                  <ol className="team-updater-history">
                    {attempt.stages.map((entry, index) => (
                      <li key={`${entry.stage}:${index}`}>
                        {t(STAGE_LABELS[entry.stage])}
                        {' · '}
                        {when(entry.at)}
                      </li>
                    ))}
                  </ol>
                )}
                {attempt.profileSnapshot && (
                  <p className="field-hint">
                    {t('catalogUpdaterPlannedContent', {
                      changes: [
                        t('catalogUpdaterIds'),
                        attempt.profileSnapshot.randomLinkVariation &&
                          t('catalogRandomLinkVariation'),
                        attempt.profileSnapshot.refreshImages && t('catalogUpdaterRefreshImages'),
                        attempt.profileSnapshot.refreshTexts && t('catalogUpdaterRefreshTexts'),
                        attempt.profileSnapshot.growProducts && t('catalogUpdaterGrow'),
                        attempt.profileSnapshot.restitch && t('catalogUpdaterRestitch')
                      ]
                        .filter(Boolean)
                        .join(', ')
                    })}
                  </p>
                )}
              </details>
              {attempt.failureCode && (
                <span> · {teamErrorMessageFor({ code: attempt.failureCode }, t)}</span>
              )}
              {attempt.deliveryVerifiedAt && (
                <span>
                  {' '}
                  ·{' '}
                  {t('catalogUpdaterDelivered', {
                    date: when(attempt.deliveryVerifiedAt)
                  })}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {retryError && (
        <p role="alert" className="team-inline-error">
          {retryError}
        </p>
      )}
      {onRetry && retrySource && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={retryPending || retryDisabled}
          onClick={() => void retry(retrySource.attemptId)}
        >
          {t('catalogUpdaterRetryNow')}
        </Button>
      )}
      {retrySource &&
        currentProfileVersion !== undefined &&
        retrySource.profileVersion !== null &&
        retrySource.profileVersion !== undefined &&
        retrySource.profileVersion !== currentProfileVersion && (
          <p className="field-hint">{t('catalogUpdaterRetryCurrentProfile')}</p>
        )}
    </div>
  );
}
