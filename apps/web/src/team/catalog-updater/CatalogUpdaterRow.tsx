import type { ReactNode } from 'react';
import { Check, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import type {
  CatalogUpdateSchedule,
  TeamAnalyticsStorage,
  TeamPermissions
} from '@video-compressor/shared';
import type { CatalogRegistryRow, CatalogUpdaterInterval } from '../../api/team';
import { Alert, Button, Checkbox, IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { CatalogFixButton, catalogCodeMessage } from '../catalogFixActions';
import { CatalogBackgroundStalledNote } from './CatalogBackgroundStalledNote';
import {
  catalogDriveStanding,
  catalogRowActivity,
  catalogSettingsLock
} from './catalogRowActivity';
import { CatalogIconControls } from './CatalogIconControls';
import { CatalogIdentity } from './CatalogIdentity';
import { CatalogProgressRow } from './CatalogProgressRow';
import { CatalogRowPublicationNote } from './CatalogRowPublicationNote';
import { CatalogRowStage } from './CatalogRowStage';
import type { CatalogUpdaterDialogClient } from './CatalogUpdaterDialog';
import { catalogNameParts, lastSuccess, needsVideo } from './catalogRowState';
import { UpdaterIntervalPicker } from './UpdaterIntervalPicker';
import { UpdaterRowActions } from './UpdaterRowActions';
import type { CatalogField, useCatalogInlineChanges, Value } from './useCatalogInlineChanges';

/** What every row of the manager shares, built once per render of the list (070, T056). */
export interface CatalogRowContext {
  teamId: string;
  client: CatalogUpdaterDialogClient;
  mayRun: boolean;
  permissions: TeamPermissions | null | undefined;
  storageKind: TeamAnalyticsStorage | null;
  clockOffsetMs: number;
  editorPending: boolean;
  busyIds: ReadonlySet<string>;
  inline: ReturnType<typeof useCatalogInlineChanges>;
  when: (iso: string) => string;
  shortWhen: (iso: string) => string;
  createdDate: Intl.DateTimeFormat;
  changeField: (row: CatalogRegistryRow, field: CatalogField, value: Value) => void;
  saveSchedule: (
    row: CatalogRegistryRow,
    interval: CatalogUpdaterInterval | null,
    schedule: CatalogUpdateSchedule | null
  ) => Promise<void>;
  videoR2For: (
    catalogId: string,
    locked?: string,
    kind?: 'video' | 'image'
  ) => Parameters<typeof CatalogIconControls>[0]['videoR2'];
  onReveal?: (row: CatalogRegistryRow) => void;
  /** Everything a row opens, run or stops — the dialog owns the windows. */
  open: (
    what: 'configure' | 'history' | 'rename' | 'videoVariations' | 'publication' | 'videoCatalogs',
    row: CatalogRegistryRow
  ) => void;
  run: (row: CatalogRegistryRow) => void;
  stop: (row: CatalogRegistryRow) => void;
  /**
   * This catalog's re-stitching cannot run: the space has both screens off, and a run, a schedule
   * or the server's own round was refused for it (2026-11-25). The row says so, with the way there.
   */
  restitchOff: (row: CatalogRegistryRow) => boolean;
  openRestitchSettings: () => void;
  reload: () => void;
}

/**
 * A word in the row that opens what it is about — the run's history, the catalog's settings.
 * The inventory's link button (070, T056): it was a bare `<button>` styled to look like text.
 */
function OutcomeButton({
  quiet = false,
  title,
  onClick,
  children
}: {
  quiet?: boolean;
  title?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      color={quiet ? 'neutral' : 'warning'}
      variant="link"
      size="xs"
      className="catalog-outcome-details"
      title={title}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** One catalog in the manager's list, out of the dialog (070, T056). */
export function CatalogUpdaterRow({
  row,
  ctx,
  selected,
  duplicateName,
  onToggle
}: {
  row: CatalogRegistryRow;
  ctx: CatalogRowContext;
  selected: boolean;
  /** Another catalog has the same name: the row says where this one lives. */
  duplicateName: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const actions = {
    configure: () => ctx.open('configure', row),
    history: () => ctx.open('history', row),
    rename: () => ctx.open('rename', row),
    videoVariations: () => ctx.open('videoVariations', row),
    publication: () => ctx.open('publication', row),
    videoCatalogs: () => ctx.open('videoCatalogs', row),
    run: () => ctx.run(row),
    stop: () => ctx.stop(row),
    reload: ctx.reload
  };
  const busy = ctx.busyIds.has(row.catalogId) || ctx.inline.blocked(row.catalogId);
  const restitchOff = ctx.restitchOff(row);
  // 072 П5: one answer for the button, the lock, the bar and its motion.
  const activity = catalogRowActivity(row, Date.now() + ctx.clockOffsetMs);
  const lock = catalogSettingsLock(row, Date.now() + ctx.clockOffsetMs);
  const runningLock =
    lock === 'running'
      ? t('catalogLockedWhileRunning')
      : lock === 'checking'
        ? t('catalogLockedWhileChecking')
        : undefined;
  const otherFolder =
    catalogDriveStanding(row) === 'other_folder'
      ? t('catalogOtherFolderRunHint', { folder: row.driveConnection?.folderName ?? '' })
      : undefined;
  const nextTry = activity.retryAt
    ? t('catalogNextTryAt', { time: ctx.shortWhen(activity.retryAt) })
    : null;
  const successfulAt = lastSuccess(row);
  const result = row.profile?.lastResult;
  const requiresReview = row.lastUpdateError === 'CATALOG_ATTEMPT_STATE_INCONSISTENT';
  const lastLabel = successfulAt
    ? ctx.shortWhen(successfulAt)
    : row.profile?.lastSuccessfulAt === null &&
        row.profile?.lastResult &&
        // The first update still running has not failed: it reads as never updated.
        row.profile.lastResult !== 'running'
      ? t('catalogUpdaterNoSuccessfulUpdate')
      : row.updateCount > 0
        ? t('catalogUpdaterUnknownTime')
        : t('catalogUpdaterNeverUpdated');
  const state = ctx.inline.states[row.catalogId];
  const next = row.nextRunAt
    ? Date.parse(row.nextRunAt) <= Date.now() + ctx.clockOffsetMs
      ? t('catalogIconsWaiting')
      : ctx.shortWhen(row.nextRunAt)
    : t('catalogIconsNextUnknown');
  const disabledReason = !ctx.mayRun
    ? t('catalogIconsReadOnly')
    : (runningLock ?? (busy || ctx.editorPending ? t('catalogIconsPendingRun') : undefined));
  const showStop = activity.active;
  return (
    <CatalogProgressRow
      row={row}
      motion={activity.motion}
      data-catalog-id={row.catalogId}
      onClick={event => {
        if (!ctx.mayRun || !(event.target instanceof Element)) return;
        if (!event.currentTarget.contains(event.target)) return;
        if (
          event.target.closest(
            'button, a, input, label, select, textarea, [role="button"], [role="checkbox"], [contenteditable="true"]'
          )
        )
          return;
        onToggle();
      }}
      className={selected ? 'is-selected' : undefined}
    >
      <td>
        {ctx.mayRun && (
          <Checkbox
            className="catalog-selection-check"
            checked={selected}
            aria-label={t('catalogUpdaterSelectFor', { name: row.name })}
            onChange={onToggle}
          />
        )}
      </td>
      <td className="catalog-name-cell">
        <div className="catalog-name-line">
          <span className="catalog-name-primary">
            <CatalogIdentity
              name={row.name}
              previousNames={row.nameAliases}
              parts={catalogNameParts(row.name)}
              context={`${row.videoName} · ${row.folderName ?? t('catalogUpdaterSpaceRoot')}`}
              sheetUrl={row.sheetUrl}
              onConfigure={actions.configure}
              configureLocked={runningLock}
              onRename={ctx.permissions?.edit ? actions.rename : undefined}
            />
            <span
              className="catalog-save-indicator"
              role="status"
              data-phase={state?.phase}
              aria-label={
                state?.phase === 'pending'
                  ? t('catalogIconsSaving')
                  : state?.phase === 'saved'
                    ? t('catalogIconsSaved')
                    : undefined
              }
              title={
                state?.phase === 'pending'
                  ? t('catalogIconsSaving')
                  : state?.phase === 'saved'
                    ? t('catalogIconsSaved')
                    : undefined
              }
            >
              {state?.phase === 'pending' ? (
                <LoaderCircle
                  size={16}
                  strokeWidth={ICON_STROKE}
                  className="is-spinning"
                  aria-hidden="true"
                />
              ) : state?.phase === 'saved' ? (
                <Check size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : null}
            </span>
          </span>
          {Number.isFinite(Date.parse(row.createdAt)) ? (
            <time
              className="catalog-created-at"
              dateTime={row.createdAt}
              aria-label={t('catalogCreatedOn', { date: ctx.when(row.createdAt) })}
              title={t('catalogCreatedOn', { date: ctx.when(row.createdAt) })}
            >
              {ctx.createdDate.format(new Date(row.createdAt))}
            </time>
          ) : (
            <span className="catalog-created-at" title={t('catalogUpdaterUnknownTime')}>
              —
            </span>
          )}
        </div>
        {duplicateName && (
          <small
            title={`${row.videoName} · ${row.folderName ?? t('catalogUpdaterSpaceRoot')} · ${row.catalogId}`}
          >
            {row.folderName ?? row.videoName} · {row.catalogId.slice(-6)}
          </small>
        )}
        {!restitchOff &&
          row.videoGeneration &&
          ['accepted', 'preparing', 'cancel_requested', 'unknown'].includes(
            row.videoGeneration.state
          ) && (
            <small role="status">
              {t('catalogVideoCreationProgress', {
                ready: row.videoGeneration.registeredCount,
                total: row.videoGeneration.requestedCount
              })}
              {row.videoGeneration.state === 'unknown'
                ? ` · ${t('catalogUpdaterVideoUnknownStop')}`
                : row.videoGeneration.state === 'cancel_requested'
                  ? ` · ${t('catalogVideoCreationCanceling')}`
                  : ''}
            </small>
          )}
        {row.videoPublication && (
          <CatalogRowPublicationNote
            publication={row.videoPublication}
            onOpen={ctx.mayRun ? actions.publication : undefined}
          />
        )}
        <span
          // The running stage is shown, not only announced: with it hidden the row
          // said only «Готово відео: 0 з 1» while the round stitched (1.4.3).
          className="catalog-row-feedback"
          role="status"
        >
          {restitchOff ? null : activity.motion === 'problem' ||
            activity.motion === 'stalled' ? null : requiresReview ? (
            <OutcomeButton
              title={teamErrorMessageFor({ code: row.lastUpdateError }, t)}
              onClick={actions.history}
            >
              {t('catalogRunNeedsReview')}
            </OutcomeButton>
          ) : activity.active ? (
            // One stage, one place: the delivery check that follows the
            // round goes through the same forward-only stage, so the row
            // no longer steps back from «Зберігаємо…» to «Перевіряємо
            // таблицю…» seconds before success (1.4.3 QA).
            <CatalogRowStage
              row={row}
              fallback={
                row.profile?.reconciliationRequired
                  ? 'catalogUpdaterStageVerifying'
                  : needsVideo(row) && row.profile?.restitchStatus !== 'ready'
                    ? row.profile?.restitchStatus === 'preparing'
                      ? 'catalogRunPreparingVideo'
                      : 'catalogRunVideoWaiting'
                    : 'catalogUpdaterUpdatingNow'
              }
              // Standing work says it stands: queued, or when it is tried next.
              suffix={
                activity.motion !== 'waiting'
                  ? null
                  : (nextTry ??
                    // «Waiting its turn» only before the round has started anything.
                    (activity.stop === 'round' &&
                    (!row.updateStage || row.updateStage === 'preparing')
                      ? t('catalogWorkQueued')
                      : null))
              }
            />
          ) : row.profile?.reconciliationRequired ? (
            <OutcomeButton
              quiet={row.profile.lastResult === 'running'}
              title={t(
                row.profile.lastResult === 'running'
                  ? 'catalogDeliveryCheckingHint'
                  : 'catalogDeliveryUncertainHint'
              )}
              onClick={actions.history}
            >
              {t(
                row.profile.lastResult === 'running'
                  ? 'catalogRunVerifying'
                  : 'catalogDeliveryUncertain'
              )}
            </OutcomeButton>
          ) : otherFolder ? (
            // Not an error to fix by reconnecting: the history says what it is and what helps.
            <OutcomeButton quiet title={otherFolder} onClick={actions.history}>
              {t('catalogOtherFolderRow')}
            </OutcomeButton>
          ) : row.lastUpdateError ||
            ['failed', 'partial', 'unknown'].includes(row.profile?.lastResult ?? '') ? (
            <OutcomeButton onClick={actions.history}>
              {t(
                row.profile?.lastResult === 'partial'
                  ? 'catalogRunPartial'
                  : row.profile?.lastResult === 'unknown'
                    ? 'catalogRunUnknown'
                    : 'catalogRunFailed'
              )}
            </OutcomeButton>
          ) : needsVideo(row) && row.profile?.restitchStatus === 'blocked' ? (
            <OutcomeButton onClick={actions.configure}>
              {t('catalogRunNextVideoFailed')}
            </OutcomeButton>
          ) : null}
        </span>
        {!restitchOff && (activity.motion === 'problem' || activity.motion === 'stalled') && (
          // 072 П5: work that stands says why in the row, with the way on — also between the
          // tries of a round whose last try failed, not only after it ended.
          <div className="catalog-row-problem" role="status">
            <span className="catalog-row-problem-text">
              {row.videoGeneration?.state === 'unknown'
                ? t('catalogUpdaterVideoUnknownStop')
                : catalogCodeMessage(activity.code, t)}
              {nextTry ? ` · ${nextTry}` : ''}
            </span>
            {activity.motion === 'stalled' ? (
              <CatalogBackgroundStalledNote teamId={ctx.teamId} onRetried={actions.reload} />
            ) : (
              <CatalogFixButton
                teamId={ctx.teamId}
                code={activity.code}
                onRepaired={actions.reload}
                catalogUrl={row.sheetUrl}
              />
            )}
            <OutcomeButton quiet onClick={actions.history}>
              {t('catalogUpdaterHistory')}
            </OutcomeButton>
          </div>
        )}
        {restitchOff && (
          <Alert
            color="warning"
            live="alert"
            className="catalog-row-restitch-off"
            action={
              <Button size="sm" color="neutral" onClick={ctx.openRestitchSettings}>
                {t('catalogOpenRestitchSettings')}
              </Button>
            }
          >
            {t('catalogRestitchOff')}
          </Alert>
        )}
        {state && ['error', 'conflict', 'unknown'].includes(state.phase) && (
          <div className="catalog-row-error" role="alert">
            {state.phase === 'unknown'
              ? t('catalogIconsUnknown')
              : state.phase === 'conflict'
                ? t('catalogIconsConflict')
                : teamErrorMessageFor({ code: state.code }, t)}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                state.phase === 'unknown'
                  ? void ctx.inline.reconcile(row.catalogId)
                  : ctx.changeField(row, state.field, state.intended)
              }
            >
              {t(state.phase === 'unknown' ? 'catalogIconsCheck' : 'catalogIconsRetryIntent')}
            </Button>
          </div>
        )}
      </td>
      <td>
        {row.profile ? (
          <CatalogIconControls
            profile={row.profile}
            restitchProgress={row.restitchProgress}
            updatePending={row.updatePending}
            restitching={row.updatePending && row.updateStage === 'restitching'}
            name={row.name}
            state={state}
            disabledReason={disabledReason}
            onChange={(field, value) => ctx.changeField(row, field, value)}
            onReadiness={runningLock ? undefined : actions.configure}
            videoR2={ctx.videoR2For(row.catalogId, runningLock, row.profile?.creativeKind)}
          />
        ) : (
          <small>{t('catalogUpdaterProfileUnknown')}</small>
        )}
      </td>
      <td className="catalog-schedule-cell">
        <UpdaterIntervalPicker
          clockOffsetMs={ctx.clockOffsetMs}
          value={row.updateInterval}
          label={t('catalogUpdaterIntervalFor', { name: row.name })}
          disabled={
            Boolean(disabledReason) || !row.profile || !ctx.client.patchCatalogUpdateProfile
          }
          nextLabel={row.updateInterval ? next : undefined}
          nextTitle={row.nextRunAt ? ctx.when(row.nextRunAt) : undefined}
          schedule={row.profile?.schedule}
          nextRunAt={row.nextRunAt}
          onSaveSchedule={(interval, schedule) => ctx.saveSchedule(row, interval, schedule)}
          onChange={value => ctx.changeField(row, 'updateInterval', value)}
        />
      </td>
      <td className="catalog-last-cell">
        <Button
          color="neutral"
          variant="ghost"
          size="sm"
          className="catalog-date-button"
          title={successfulAt ? ctx.when(successfulAt) : undefined}
          onClick={actions.history}
          aria-label={`${t('catalogIconsLastSuccess')}: ${row.name} · ${successfulAt ? ctx.when(successfulAt) : lastLabel}${result ? ` · ${t(`catalogUpdaterResult_${result}`)}` : ''}`}
        >
          {lastLabel}
        </Button>
      </td>
      <td>
        <div className="catalog-row-actions">
          {ctx.mayRun && (
            <IconButton
              // Run and stop are different buttons: a native tooltip already on
              // screen would go on saying "Stop this update" over the run button.
              // Stop shows for any work the row shows (072, П5): a catalog whose videos or
              // delivery check were under way showed progress beside «run».
              key={showStop ? 'stop' : 'run'}
              color={showStop ? 'error' : 'success'}
              variant="soft"
              data-setting-save={
                state?.phase === 'pending' &&
                !ctx.busyIds.has(row.catalogId) &&
                !ctx.editorPending &&
                !row.profile?.reconciliationRequired
                  ? 'true'
                  : undefined
              }
              label={
                !showStop
                  ? (otherFolder ?? t('catalogUpdaterNowFor', { name: row.name }))
                  : activity.stop === 'round'
                    ? t('catalogUpdaterCancelUpdate', { name: row.name })
                    : activity.stop === 'verifying'
                      ? t('catalogStopVerifyingHint')
                      : t('catalogStopVideosHint')
              }
              disabled={
                busy ||
                ctx.editorPending ||
                (showStop
                  ? activity.stop !== 'round' || !ctx.client.cancelCatalogUpdate
                  : Boolean(row.profile?.reconciliationRequired) || Boolean(otherFolder))
              }
              onClick={() => (showStop ? void actions.stop() : void actions.run())}
            >
              {showStop ? (
                <Square size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              ) : (
                <RefreshCw size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              )}
            </IconButton>
          )}
          {ctx.permissions && (
            <UpdaterRowActions
              storageKind={ctx.storageKind}
              row={row}
              teamId={ctx.teamId}
              permissions={ctx.permissions}
              lockedReason={runningLock}
              onVideoVariations={ctx.mayRun ? actions.videoVariations : undefined}
              onPublication={ctx.mayRun ? actions.publication : undefined}
              onChanged={actions.reload}
              onRename={ctx.permissions.edit ? actions.rename : undefined}
              onReveal={ctx.onReveal}
              onConfigure={row.profile ? actions.configure : undefined}
              onHistory={ctx.client.listCatalogUpdateAttempts ? actions.history : undefined}
              onVideoCatalogs={actions.videoCatalogs}
            />
          )}
        </div>
      </td>
    </CatalogProgressRow>
  );
}
