import { usePrivateCacheEpoch } from '../private-cache-scope';
import { createReadCoordinator, withReadDeadline } from '../readCoordinator';
import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateAttempt } from '@video-compressor/shared';
import { ChevronDown } from 'lucide-react';
import type { CatalogDriveConnectionInfo } from '../../api/catalog-manager-runtime';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Alert, Badge, Button, Collapse, Link, type UiColor } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import { CatalogFixButton, catalogCodeMessage, catalogErrorMessageFor } from '../catalogFixActions';
import { teamErrorMessageFor } from '../errors';
import './catalog-manager-activity.css';

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

const RESULT_COLOR: Record<CatalogUpdateAttempt['result'], UiColor> = {
  running: 'info',
  success: 'success',
  partial: 'warning',
  failed: 'error',
  cancelled: 'neutral',
  unknown: 'warning'
};

/** Drive codes a round ends with when the catalog's connection could not be used. */
const DRIVE_CODES = new Set([
  'NEEDS_REAUTH',
  'ROOT_MISSING',
  'DRIVE_UNAVAILABLE',
  'CONNECTION_DETACHED'
]);

const HISTORY_PAGE = 10;

export function CatalogStatusDetails(props: Parameters<typeof CatalogStatusDetailsScope>[0]) {
  const epoch = usePrivateCacheEpoch();
  return (
    <CatalogStatusDetailsScope key={`${props.teamId}:${props.catalogId}:${epoch}`} {...props} />
  );
}

function CatalogStatusDetailsScope({
  teamId,
  catalogId,
  currentProfileVersion,
  activeAttemptId,
  currentFailureCode,
  load,
  onClose,
  onRetry,
  checkingDelivery = false,
  retryDisabled = false,
  driveConnection,
  sheetUrl
}: {
  teamId: string;
  catalogId: string;
  currentProfileVersion?: number;
  /** Undefined is a legacy server; null explicitly means no active attempt. */
  activeAttemptId?: string | null;
  /** Current runtime problem; never rewrites the immutable historical terminal. */
  currentFailureCode?: string | null;
  load: (
    teamId: string,
    catalogId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<CatalogUpdateAttempt[]>;
  onClose: () => void;
  onRetry?: (sourceAttemptId: string) => Promise<void> | void;
  retryDisabled?: boolean;
  checkingDelivery?: boolean;
  /** The Drive folder the catalog belongs to (072, П5): says whether a Drive failure still stands. */
  driveConnection?: CatalogDriveConnectionInfo | null;
  sheetUrl?: string;
}) {
  const { t, language } = useI18n();
  const [attempts, setAttempts] = useState<CatalogUpdateAttempt[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [retryPending, setRetryPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE);
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
      setRetryError(catalogErrorMessageFor(cause, t));
      // A lost command reply must be reconciled before offering another mutation.
      setAttempts(null);
      setRevision(value => value + 1);
    } finally {
      retryLock.current = false;
      setRetryPending(false);
    }
  };
  useEffect(() => {
    let active = true;
    setAttempts(null);
    setError(false);
    const reader = createReadCoordinator(async signal => {
      const rows = await withReadDeadline(
        child => load(teamId, catalogId, { signal: child }),
        signal
      );
      if (active && !signal.aborted) {
        setAttempts(rows);
        setError(false);
      }
    });
    const refresh = (foreground = false) => {
      if (document.hidden || (reader.isRunning() && !foreground)) return;
      reader.start();
      void reader.request().catch(() => {
        if (active && !document.hidden) setError(true);
      });
    };
    const visibility = () => {
      if (document.hidden) reader.stop();
      else refresh(true);
    };
    refresh();
    document.addEventListener('visibilitychange', visibility);
    const timer = checkingDelivery ? window.setInterval(refresh, 5000) : null;
    return () => {
      active = false;
      reader.stop();
      document.removeEventListener('visibilitychange', visibility);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [teamId, catalogId, load, revision, checkingDelivery]);
  const date = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  const when = (iso: string) => date.format(new Date(iso));
  const clock = new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    timeStyle: 'medium'
  });
  const time = (iso: string) => clock.format(new Date(iso));
  const orderedAttempts = attempts
    ? [...attempts].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    : null;
  const latest = orderedAttempts?.[0];
  const activeAttempt =
    activeAttemptId === undefined
      ? latest
      : orderedAttempts?.find(attempt => attempt.attemptId === activeAttemptId);
  const retrySource =
    latest && (latest.result === 'failed' || latest.result === 'partial') ? latest : null;
  const shownAttempts = orderedAttempts?.slice(0, visibleCount) ?? null;
  const hiddenCount = (orderedAttempts?.length ?? 0) - (shownAttempts?.length ?? 0);
  const otherFolder = driveConnection?.state === 'detached';
  // A catalog of a folder the space left cannot be updated: nothing to retry.
  const canRetry = Boolean(onRetry && retrySource) && !otherFolder;
  /** Why a past try failed: a Drive code on a catalog of the previous folder says that. */
  const reasonOf = (code: string) =>
    otherFolder && DRIVE_CODES.has(code)
      ? t('catalogOtherFolderAttemptReason')
      : code === 'NEEDS_REAUTH'
        ? teamErrorMessageFor({ code }, t)
        : catalogCodeMessage(code, t);
  const retryButton = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={retryPending || retryDisabled}
      onClick={() => retrySource && void retry(retrySource.attemptId)}
    >
      {t('catalogUpdaterRetryNow')}
    </Button>
  );
  const standing: 'other_folder' | 'reconnect' | 'restored' | 'failed' | null = otherFolder
    ? 'other_folder'
    : driveConnection?.state === 'needs_reauth' || driveConnection?.state === 'root_missing'
      ? 'reconnect'
      : currentFailureCode &&
          DRIVE_CODES.has(currentFailureCode) &&
          driveConnection?.state === 'connected'
        ? 'restored'
        : currentFailureCode
          ? 'failed'
          : null;
  return (
    <div
      className="team-updater-profile catalog-history"
      role="group"
      aria-label={t('catalogUpdaterHistory')}
    >
      <div className="team-updater-profile-actions">
        <strong>{t('catalogUpdaterHistory')}</strong>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('catalogUpdaterClose')}
        </Button>
      </div>
      {/* What stands now, in words a person can act on (072, П5): what happened, whether it is
          serious, what to do — and the button that does it. */}
      {standing === 'other_folder' && (
        <Alert
          color="warning"
          live="alert"
          title={t('catalogOtherFolderTitle')}
          action={
            sheetUrl ? (
              <Link href={sheetUrl} target="_blank" rel="noopener noreferrer">
                {t('catalogIconsOpenSheet')}
              </Link>
            ) : undefined
          }
        >
          {driveConnection?.spaceFolderName
            ? t('catalogOtherFolderBody', {
                folder: driveConnection.folderName ?? '',
                space: driveConnection.spaceFolderName
              })
            : t('catalogOtherFolderBodyNoSpace', { folder: driveConnection?.folderName ?? '' })}
        </Alert>
      )}
      {standing === 'reconnect' && (
        <Alert
          color="warning"
          live="alert"
          title={t('catalogDriveReconnectTitle')}
          action={
            <CatalogFixButton
              teamId={teamId}
              code={driveConnection?.state === 'root_missing' ? 'ROOT_MISSING' : 'NEEDS_REAUTH'}
            />
          }
        >
          {t('catalogDriveReconnectBody')}
        </Alert>
      )}
      {standing === 'restored' && (
        <Alert
          color="info"
          title={t('catalogDriveRestoredTitle')}
          action={canRetry ? retryButton : undefined}
        >
          {t('catalogDriveRestoredBody')}
        </Alert>
      )}
      {standing === 'failed' && (
        <Alert
          color="warning"
          live="alert"
          title={t('catalogLastUpdateFailedTitle')}
          action={<CatalogFixButton teamId={teamId} code={currentFailureCode} />}
        >
          {catalogCodeMessage(currentFailureCode, t)}
        </Alert>
      )}
      {error && (
        <Alert
          color="error"
          live="alert"
          action={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRevision(value => value + 1)}
            >
              {t('catalogUpdaterRetry')}
            </Button>
          }
        >
          {t('catalogUpdaterHistoryFailed')}
        </Alert>
      )}
      {!error && attempts === null && <p>{t('catalogUpdaterLoading')}</p>}
      {attempts?.length === 0 && <p>{t('catalogUpdaterHistoryEmpty')}</p>}
      {checkingDelivery && activeAttempt?.result === 'running' && (
        <p className="field-hint">{t('catalogDeliveryCheckingHint')}</p>
      )}
      {shownAttempts && shownAttempts.length > 0 && (
        <ol className="catalog-history-list">
          {shownAttempts.map(attempt => {
            const checking =
              checkingDelivery && attempt === activeAttempt && attempt.result === 'running';
            const open = expanded.has(attempt.attemptId);
            const detailsId = `catalog-history-${attempt.attemptId}`;
            const note =
              attempt.result === 'partial'
                ? attempt.deliveryVerifiedAt &&
                  attempt.profileSnapshot?.restitch &&
                  attempt.actualChanges?.videoReplaced === false
                  ? t('catalogUpdaterPartialVideo', {
                      date: when(attempt.deliveryVerifiedAt),
                      stage: attempt.stages?.at(-1)
                        ? t(STAGE_LABELS[attempt.stages.at(-1)!.stage])
                        : t('catalogUpdaterUnknownStage')
                    })
                  : t('catalogUpdaterPartialUnknown')
                : attempt.result === 'unknown'
                  ? t(
                      checkingDelivery && attempt === activeAttempt
                        ? 'catalogDeliveryUncertainHint'
                        : 'catalogUpdaterUnknownDelivery'
                    )
                  : null;
            return (
              <li key={attempt.attemptId} className="catalog-history-item">
                <div className="catalog-history-line">
                  <Badge size="sm" color={checking ? 'info' : RESULT_COLOR[attempt.result]}>
                    {checking
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
                  </Badge>
                  <div className="catalog-history-when">
                    <time dateTime={attempt.startedAt}>{when(attempt.startedAt)}</time>
                    <span className="catalog-history-meta">
                      {attempt.trigger === 'manual'
                        ? t('catalogUpdaterManual')
                        : attempt.trigger === 'schedule'
                          ? t('catalogUpdaterScheduled')
                          : attempt.trigger === 'retry'
                            ? t('catalogUpdaterRetryNow')
                            : t('catalogUpdaterUnknownTrigger')}
                      {attempt.endedAt
                        ? ` · ${t('catalogUpdaterEndedAt', { date: when(attempt.endedAt) })}`
                        : ''}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    color="neutral"
                    aria-expanded={open}
                    aria-controls={detailsId}
                    onClick={() =>
                      setExpanded(current => {
                        const next = new Set(current);
                        if (!next.delete(attempt.attemptId)) next.add(attempt.attemptId);
                        return next;
                      })
                    }
                  >
                    {t('catalogUpdaterDetails')}
                    <ChevronDown
                      size={ICON_SIZE}
                      strokeWidth={ICON_STROKE}
                      aria-hidden="true"
                      className={open ? 'is-flipped' : undefined}
                    />
                  </Button>
                </div>
                {(attempt.failureCode ||
                  note ||
                  (attempt.deliveryVerifiedAt && attempt.actualChanges)) && (
                  <p className="catalog-history-reason">
                    {attempt.failureCode && reasonOf(attempt.failureCode)}
                    {attempt.failureCode && (note || attempt.actualChanges) ? ' ' : ''}
                    {note}
                    {attempt.deliveryVerifiedAt &&
                      attempt.actualChanges &&
                      t('catalogUpdaterActualChanges', {
                        changes:
                          [
                            attempt.actualChanges.productIds && t('catalogUpdaterIds'),
                            attempt.actualChanges.linksVaried && t('catalogRandomLinkVariation'),
                            attempt.actualChanges.imagesRefreshed &&
                              t('catalogUpdaterRefreshImages'),
                            attempt.actualChanges.textsRefreshed && t('catalogUpdaterRefreshTexts'),
                            attempt.actualChanges.productsAdded && t('catalogUpdaterGrow'),
                            attempt.actualChanges.videoReplaced && t('catalogUpdaterRestitch')
                          ]
                            .filter(Boolean)
                            .join(', ') || t('catalogUpdaterNoActualEvidence')
                      })}
                  </p>
                )}
                <Collapse open={open}>
                  <div id={detailsId} className="catalog-history-details">
                    <dl>
                      {attempt.profileSnapshot && (
                        <>
                          <dt>{t('catalogHistoryPlanned')}</dt>
                          <dd>
                            {[
                              t('catalogUpdaterIds'),
                              attempt.profileSnapshot.randomLinkVariation &&
                                t('catalogRandomLinkVariation'),
                              attempt.profileSnapshot.refreshImages &&
                                t('catalogUpdaterRefreshImages'),
                              attempt.profileSnapshot.refreshTexts &&
                                t('catalogUpdaterRefreshTexts'),
                              attempt.profileSnapshot.growProducts && t('catalogUpdaterGrow'),
                              attempt.profileSnapshot.restitch && t('catalogUpdaterRestitch')
                            ]
                              .filter(Boolean)
                              .join(', ')}
                          </dd>
                        </>
                      )}
                      {attempt.deliveryVerifiedAt && (
                        <>
                          <dt>{t('catalogHistoryChanged')}</dt>
                          <dd>
                            {t('catalogUpdaterDelivered', {
                              date: when(attempt.deliveryVerifiedAt)
                            })}
                          </dd>
                        </>
                      )}
                      {attempt.stages && attempt.stages.length > 0 && (
                        <>
                          <dt>{t('catalogHistoryStages')}</dt>
                          <dd>
                            <ol className="catalog-history-stages">
                              {attempt.stages.map((entry, index) => (
                                <li key={`${entry.stage}:${index}`}>
                                  {t(STAGE_LABELS[entry.stage])} · {time(entry.at)}
                                </li>
                              ))}
                            </ol>
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                </Collapse>
              </li>
            );
          })}
        </ol>
      )}
      {retryError && (
        <p role="alert" className="team-inline-error">
          {retryError}
        </p>
      )}
      <div className="catalog-history-footer">
        {hiddenCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setVisibleCount(count => count + HISTORY_PAGE)}
          >
            {t('catalogHistoryShowMore', { count: Math.min(hiddenCount, HISTORY_PAGE) })}
          </Button>
        )}
        {canRetry && standing !== 'restored' && retryButton}
      </div>
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
