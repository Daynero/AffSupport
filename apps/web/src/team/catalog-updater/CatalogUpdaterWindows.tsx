import type { Dispatch, RefObject, SetStateAction } from 'react';
import { catalogHasOneVideo } from '@video-compressor/shared';
import type { TeamPermissions } from '@video-compressor/shared';
import { TeamApiError, type CatalogRegistryRow } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { teamErrorMessageFor } from '../errors';
import { spaceRouteFor } from '../SpaceSettingsLink';
import type { useCatalogVideoR2Team } from '../product-catalog/useCatalogVideoR2Team';
import { CatalogBulkEditor } from './CatalogBulkEditor';
import {
  CatalogIconControls,
  CatalogIconLegend,
  CATALOG_FIELDS,
  catalogVideoR2Sentence
} from './CatalogIconControls';
import { CatalogProfileVideoCount } from './CatalogProfileVideoCount';
import { CatalogStatusDetails } from './CatalogStatusDetails';
import { CatalogUpdateProgress } from './CatalogUpdateProgress';
import type { CatalogUpdaterDialogClient } from './CatalogUpdaterDialog';
import type { CatalogRowContext } from './CatalogUpdaterRow';
import { needsVideo } from './catalogRowState';
import type { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import { readCatalogSnapshot } from './readCatalogSnapshot';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';
import type { useCatalogCommands } from './useCatalogCommands';
import type { CatalogField, useCatalogInlineChanges } from './useCatalogInlineChanges';

type Setter<T> = Dispatch<SetStateAction<T>>;

/**
 * The windows the catalog manager opens over its list — what the icons mean, one catalog's
 * settings, its update history, the settings of a selection, the recent changes — out of the
 * dialog (070, T056). The dialog keeps which one is open; these draw it.
 */
export interface CatalogUpdaterWindowsProps {
  titleId: string;
  teamId: string;
  client: CatalogUpdaterDialogClient;
  rows: readonly CatalogRegistryRow[];
  rowsById: ReadonlyMap<string, CatalogRegistryRow>;
  liveSelected: readonly CatalogRegistryRow[];
  mayRun: boolean;
  permissions: TeamPermissions | null | undefined;
  editorPending: boolean;
  clockOffsetMs: number;
  busyIds: ReadonlySet<string>;
  busyRef: { current: Set<string> };
  inline: ReturnType<typeof useCatalogInlineChanges>;
  commands: ReturnType<typeof useCatalogCommands>;
  owner: ReturnType<typeof captureCatalogMutationOwner>;
  videoR2: ReturnType<typeof useCatalogVideoR2Team>;
  videoR2For: CatalogRowContext['videoR2For'];
  changeField: CatalogRowContext['changeField'];
  when: (iso: string) => string;
  shortWhen: (iso: string) => string;
  guard: (action: () => void) => void;
  legendOpen: boolean;
  setLegendOpen: Setter<boolean>;
  expandedCatalogId: string | null;
  setExpandedCatalogId: Setter<string | null>;
  historyCatalogId: string | null;
  setHistoryCatalogId: Setter<string | null>;
  bulkOpen: boolean;
  setBulkOpen: Setter<boolean>;
  bulkMode: 'all' | 'restitch' | 'schedule';
  recentOpen: boolean;
  setRecentOpen: Setter<boolean>;
  recentReturnTarget: { current: { catalogId?: string; field?: CatalogField } | null };
  setEditorDirty: Setter<boolean>;
  setEditorPending: Setter<boolean>;
  setEditorUncertain: Setter<boolean>;
  setReplaceVideoCatalogId: Setter<string | null>;
  listRef: RefObject<HTMLTableElement | null>;
  registryReload: () => void;
  onChanged?: () => void;
  /** The catalogs among these whose re-stitching cannot run in this space (2026-11-25). */
  refuseWithoutRestitch?: (catalogIds: string[]) => Promise<string[]>;
}

export function CatalogUpdaterWindows({
  titleId,
  teamId,
  client,
  rows,
  rowsById,
  liveSelected,
  mayRun,
  permissions,
  editorPending,
  clockOffsetMs,
  busyIds,
  busyRef,
  inline,
  commands,
  owner,
  videoR2,
  videoR2For,
  changeField,
  when,
  shortWhen,
  guard,
  legendOpen,
  setLegendOpen,
  expandedCatalogId,
  setExpandedCatalogId,
  historyCatalogId,
  setHistoryCatalogId,
  bulkOpen,
  setBulkOpen,
  bulkMode,
  recentOpen,
  setRecentOpen,
  recentReturnTarget,
  setEditorDirty,
  setEditorPending,
  setEditorUncertain,
  setReplaceVideoCatalogId,
  listRef,
  registryReload,
  onChanged,
  refuseWithoutRestitch
}: CatalogUpdaterWindowsProps) {
  const { t } = useI18n();
  return (
    <>
      {legendOpen && (
        <Modal
          nested
          labelledBy={`${titleId}-icon-help`}
          onClose={() => setLegendOpen(false)}
          size="md"
          className="catalog-icon-help"
          closeLabel={t('catalogUpdaterClose')}
        >
          <h2 id={`${titleId}-icon-help`}>{t('catalogIconsHelp')}</h2>
          <CatalogIconLegend
            teamId={teamId}
            videoR2={videoR2.available}
            onOpenSettings={href =>
              guard(() => {
                setLegendOpen(false);
                setExpandedCatalogId(null);
                navigateTo(href);
              })
            }
          />
        </Modal>
      )}
      {rows
        .filter(row => row.catalogId === expandedCatalogId || row.catalogId === historyCatalogId)
        .map(row => (
          <div key={row.catalogId}>
            {expandedCatalogId === row.catalogId &&
              row.profile &&
              client.patchCatalogUpdateProfile && (
                <Modal
                  nested
                  labelledBy={`${titleId}-profile`}
                  onClose={() =>
                    guard(() => {
                      setExpandedCatalogId(null);
                      setEditorDirty(false);
                    })
                  }
                  className="team-updater-detail"
                  backdropClassName="team-updater-detail-backdrop"
                  size="lg"
                >
                  <h2 id={`${titleId}-profile`}>{row.name}</h2>
                  <div className="team-updater-profile">
                    {(row.profile?.creatives?.length ?? 0) > 1 && (
                      <p className="m-0 text-ink-muted">
                        {row.profile!.creatives!.map(creative => creative.alias).join(' · ')}
                      </p>
                    )}
                    {permissions?.edit &&
                      mayRun &&
                      (!row.profile || catalogHasOneVideo(row.profile)) && (
                        <Button
                          variant="outline"
                          disabled={editorPending}
                          onClick={() => setReplaceVideoCatalogId(row.catalogId)}
                        >
                          {t('catalogReplaceVideoTitle')}
                        </Button>
                      )}

                    {row.updatePending && (
                      <div>
                        <p role="status">{t('catalogUpdaterProfileActiveAttempt')}</p>
                        <CatalogUpdateProgress
                          stage={row.updateStage}
                          restitchProgress={row.restitchProgress}
                          restitchStage={row.restitchStage}
                        />
                      </div>
                    )}
                    <strong>{t('catalogUpdaterWhen')}</strong>
                    <UpdaterIntervalPicker
                      clockOffsetMs={clockOffsetMs}
                      value={row.updateInterval}
                      label={t('catalogUpdaterIntervalFor', { name: row.name })}
                      disabled={!mayRun || inline.blocked(row.catalogId) || editorPending}
                      nextLabel={
                        row.updateInterval
                          ? row.nextRunAt
                            ? Date.parse(row.nextRunAt) <= Date.now() + clockOffsetMs
                              ? t('catalogIconsWaiting')
                              : shortWhen(row.nextRunAt)
                            : t('catalogIconsNextUnknown')
                          : undefined
                      }
                      nextTitle={row.nextRunAt ? when(row.nextRunAt) : undefined}
                      schedule={row.profile?.schedule}
                      nextRunAt={row.nextRunAt}
                      onSaveSchedule={async (interval, schedule) => {
                        if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
                        if (busyRef.current.has(row.catalogId))
                          throw new TeamApiError('WRONG_STATE', false);
                        await inline.saveSchedule(row.catalogId, { interval, schedule });
                      }}
                      onChange={value => changeField(row, 'updateInterval', value)}
                    />
                    <strong>{t('catalogUpdaterWhat')}</strong>
                    {!mayRun && <p>{t('catalogIconsReadOnly')}</p>}
                    <CatalogIconControls
                      profile={row.profile}
                      restitchProgress={row.restitchProgress}
                      updatePending={row.updatePending}
                      restitching={row.updatePending && row.updateStage === 'restitching'}
                      name={row.name}
                      state={inline.states[row.catalogId]}
                      disabledReason={
                        !mayRun
                          ? t('catalogIconsReadOnly')
                          : inline.blocked(row.catalogId) || editorPending
                            ? t('catalogIconsPendingRun')
                            : undefined
                      }
                      onChange={(field, value) => changeField(row, field, value)}
                      onReadiness={registryReload}
                      videoR2={videoR2For(row.catalogId, undefined, row.profile?.creativeKind)}
                    />
                    {videoR2.available && videoR2.row(row.catalogId).enabled && (
                      <p className="team-inline-note" data-testid="catalog-video-r2-status">
                        {catalogVideoR2Sentence(videoR2.row(row.catalogId), t)}
                      </p>
                    )}
                    {row.profile.creativeKind !== 'image' && (
                      <CatalogProfileVideoCount
                        value={row.profile.videoVariantCount ?? 1}
                        productCount={row.productCount}
                        disabled={!mayRun || inline.blocked(row.catalogId) || editorPending}
                        onSave={async value => {
                          if (!mayRun) throw new TeamApiError('PERMISSION_DENIED', false);
                          if (busyRef.current.has(row.catalogId) || inline.blocked(row.catalogId))
                            throw new TeamApiError('WRONG_STATE', false);
                          const confirmed = await inline.change(
                            row.catalogId,
                            'videoVariantCount',
                            value
                          );
                          if (!confirmed) throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
                        }}
                      />
                    )}
                    <CatalogIconLegend
                      teamId={teamId}
                      videoR2={videoR2.available}
                      onOpenSettings={href =>
                        guard(() => {
                          setLegendOpen(false);
                          setExpandedCatalogId(null);
                          navigateTo(href);
                        })
                      }
                    />
                    {needsVideo(row) && row.profile?.restitchStatus === 'blocked' && (
                      <p className="catalog-result-attention">
                        {t('catalogIconsReadinessWarning')}{' '}
                        {row.profile?.restitchBlockedCode &&
                          teamErrorMessageFor({ code: row.profile?.restitchBlockedCode }, t)}
                      </p>
                    )}
                    {needsVideo(row) && row.profile?.restitchStatus === 'blocked' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          guard(() =>
                            navigateTo(spaceRouteFor(teamId, { kind: 'settings', tab: 'restitch' }))
                          )
                        }
                      >
                        {t('teamSettingsTabRestitch')}
                      </Button>
                    )}
                    {['pending', 'unknown', 'conflict'].includes(
                      inline.states[row.catalogId]?.phase ?? ''
                    ) && (
                      <p role="status">
                        {t(
                          inline.states[row.catalogId]?.phase === 'pending'
                            ? 'catalogIconsSaving'
                            : inline.states[row.catalogId]?.phase === 'unknown'
                              ? 'catalogIconsUnknown'
                              : inline.states[row.catalogId]?.phase === 'conflict'
                                ? 'catalogIconsConflict'
                                : 'catalogIconsLegendHint'
                        )}
                      </p>
                    )}
                    {inline.states[row.catalogId]?.phase === 'unknown' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void inline.reconcile(row.catalogId)}
                      >
                        {t('catalogIconsCheck')}
                      </Button>
                    )}
                    {['error', 'conflict'].includes(inline.states[row.catalogId]?.phase ?? '') && (
                      <div role="alert">
                        {inline.states[row.catalogId]?.code &&
                          teamErrorMessageFor({ code: inline.states[row.catalogId]?.code }, t)}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const state = inline.states[row.catalogId];
                            if (state) changeField(row, state.field, state.intended);
                          }}
                        >
                          {t('catalogIconsRetryIntent')}
                        </Button>
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={inline.states[row.catalogId]?.phase === 'pending'}
                      onClick={() => setExpandedCatalogId(null)}
                    >
                      {t('catalogUpdaterClose')}
                    </Button>
                  </div>
                </Modal>
              )}
            {historyCatalogId === row.catalogId && client.listCatalogUpdateAttempts && (
              <Modal
                nested
                labelledBy={`${titleId}-history`}
                onClose={() => setHistoryCatalogId(null)}
                className="team-updater-detail"
                backdropClassName="team-updater-detail-backdrop"
                size="lg"
              >
                <h2 id={`${titleId}-history`}>{row.name}</h2>
                <CatalogStatusDetails
                  teamId={teamId}
                  catalogId={row.catalogId}
                  currentProfileVersion={row.profile?.version}
                  activeAttemptId={row.activeAttemptId}
                  currentFailureCode={row.lastUpdateError}
                  checkingDelivery={Boolean(row.profile?.reconciliationRequired)}
                  retryDisabled={
                    inline.blocked(row.catalogId) ||
                    busyIds.has(row.catalogId) ||
                    row.updatePending ||
                    row.profile?.reconciliationRequired
                  }
                  load={client.listCatalogUpdateAttempts}
                  onClose={() => {
                    setHistoryCatalogId(null);
                    requestAnimationFrame(() => {
                      if (!owner.current()) return;
                      Array.from(
                        listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
                      )
                        .find(element => element.dataset.catalogId === row.catalogId)
                        ?.querySelector<HTMLButtonElement>('.team-updater-row-actions button')
                        ?.focus();
                    });
                  }}
                  onRetry={
                    mayRun
                      ? async sourceAttemptId => {
                          if (
                            !owner.current() ||
                            inline.blocked(row.catalogId) ||
                            commands.blocked(row.catalogId) ||
                            busyRef.current.has(row.catalogId)
                          )
                            throw new TeamApiError('WRONG_STATE', false);
                          // A retry re-stitches like a run: refused here, not left to hang.
                          if ((await refuseWithoutRestitch?.([row.catalogId]))?.length)
                            throw new TeamApiError('RESTITCH_INVALID', false);
                          const outcome = await commands.submit([row.catalogId], sourceAttemptId);
                          if (outcome.kind === 'rejected' || outcome.kind === 'unknown')
                            throw outcome.error;
                        }
                      : undefined
                  }
                />
              </Modal>
            )}
          </div>
        ))}
      {bulkOpen && client.patchCatalogUpdateProfile && (
        <Modal
          nested
          labelledBy={`${titleId}-bulk`}
          onClose={() =>
            guard(() => {
              setBulkOpen(false);
              setEditorDirty(false);
            })
          }
          className="team-updater-detail"
          backdropClassName="team-updater-detail-backdrop"
          size="lg"
        >
          <h2 id={`${titleId}-bulk`}>{t('catalogUpdaterBulkSettings')}</h2>
          <CatalogBulkEditor
            clockOffsetMs={clockOffsetMs}
            mode={bulkMode}
            items={liveSelected
              .filter(row => row.profile && !inline.blocked(row.catalogId))
              .map(row => ({
                catalogId: row.catalogId,
                name: row.name,
                profile: row.profile!,
                productCount: row.productCount,
                interval: row.updateInterval
              }))}
            save={(id, version, patch) =>
              client.patchCatalogUpdateProfile!(teamId, id, version, patch, owner.options())
            }
            read={(id, options) => readCatalogSnapshot(client, teamId, id, options?.signal)}
            onDirtyChange={setEditorDirty}
            onPendingChange={setEditorPending}
            onUncertainChange={setEditorUncertain}
            onSaved={() => {
              if (!owner.current()) return;
              registryReload();
              onChanged?.();
            }}
          />
          <Button
            variant="ghost"
            onClick={() =>
              guard(() => {
                setBulkOpen(false);
                setEditorDirty(false);
              })
            }
          >
            {t('catalogUpdaterClose')}
          </Button>
        </Modal>
      )}
      {recentOpen && (
        <Modal
          nested
          labelledBy={`${titleId}-recent`}
          onClose={() => setRecentOpen(false)}
          size="lg"
        >
          <h2 id={`${titleId}-recent`}>{t('catalogIconsRecent')}</h2>
          <div className="catalog-recent-list">
            {inline.undo.map(entry => {
              const row = rowsById.get(entry.catalogId);
              const invalid = entry.invalid || row?.profile?.version !== entry.version;
              const label =
                entry.field === 'videoVariantCount'
                  ? t('catalogVideoVariationCount')
                  : entry.field === 'updateInterval' || entry.field === 'schedule'
                    ? t('catalogIconsSchedule')
                    : t(CATALOG_FIELDS.find(item => item.field === entry.field)!.label);
              return (
                <div key={`${entry.catalogId}-${entry.field}`}>
                  <strong>{row?.name ?? t('catalogUpdaterProfileUnknown')}</strong>
                  <span>
                    {label}:{' '}
                    {typeof entry.after === 'number'
                      ? entry.after
                      : typeof entry.after === 'boolean'
                        ? t(entry.after ? 'catalogUpdaterBulkOn' : 'catalogUpdaterBulkOff')
                        : intervalLabel(
                            typeof entry.after === 'object' && entry.after !== null
                              ? entry.after.interval
                              : entry.after,
                            t
                          )}
                  </span>
                  {invalid && <small>{t('catalogIconsUndoInvalid')}</small>}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      inline.states[entry.catalogId]?.phase === 'unknown'
                        ? false
                        : invalid || inline.blocked(entry.catalogId) || !mayRun
                    }
                    onClick={() => {
                      recentReturnTarget.current = {
                        catalogId: entry.catalogId,
                        field: entry.field
                      };
                      if (inline.states[entry.catalogId]?.phase === 'unknown')
                        void inline.reconcile(entry.catalogId);
                      else void inline.undoChange(entry);
                    }}
                  >
                    {t(
                      inline.states[entry.catalogId]?.phase === 'unknown'
                        ? 'catalogIconsCheck'
                        : 'catalogIconsUndo'
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              recentReturnTarget.current = {};
              inline.clearUndo();
            }}
          >
            {t('catalogIconsClearRecent')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRecentOpen(false)}>
            {t('catalogUpdaterClose')}
          </Button>
        </Modal>
      )}
    </>
  );
}
