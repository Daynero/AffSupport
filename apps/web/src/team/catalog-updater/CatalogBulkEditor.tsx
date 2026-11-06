import { privateCacheEpoch, privateCacheSuperseded } from '../private-cache-scope';
import { TeamApiError } from '../../api/team';
import { saveCatalogProfile } from './saveCatalogProfile';
import { profilePatchMatches } from './profilePatchMatches';
import type { CatalogSnapshot } from './useCatalogInlineChanges';
import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { Button, SelectMenu } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import type { CatalogUpdaterInterval } from '../../api/team';
import { beginCatalogUiFlow } from './analytics';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';
import { CatalogBulkUndo, type CatalogBulkUndoReceipt } from './CatalogBulkUndo';

const FIELDS = [
  ['randomLinkVariation', 'catalogRandomLinkVariation'],
  ['refreshImages', 'catalogUpdaterRefreshImages'],
  ['refreshTexts', 'catalogUpdaterRefreshTexts'],
  ['growProducts', 'catalogUpdaterGrow'],
  ['restitch', 'catalogUpdaterRestitch']
] as const;

type Item = {
  catalogId: string;
  name: string;
  profile: CatalogUpdateProfile;
  interval: CatalogUpdaterInterval | null;
};

export function CatalogBulkEditor({
  items,
  save,
  read,
  onSaved,
  onDirtyChange,
  onPendingChange,
  onUncertainChange,
  clockOffsetMs = 0,
  mode = 'all'
}: {
  mode?: 'all' | 'restitch' | 'schedule';
  clockOffsetMs?: number;
  items: Item[];
  save: (
    catalogId: string,
    expectedVersion: number,
    patch: CatalogUpdateProfilePatch
  ) => Promise<CatalogUpdateProfile>;
  read?: (catalogId: string, options?: { signal?: AbortSignal }) => Promise<CatalogSnapshot>;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  onUncertainChange?: (uncertain: boolean) => void;
}) {
  const mounted = useRef(true);
  const scopeEpoch = useRef(privateCacheEpoch()).current;
  const applyLocked = useRef(false);
  const scopeActive = () => mounted.current && privateCacheEpoch() === scopeEpoch;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { t } = useI18n();
  const [draft, setDraft] = useState<CatalogUpdateProfilePatch>({});
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [successCount, setSuccessCount] = useState(0);
  const [undoReceipts, setUndoReceipts] = useState<CatalogBulkUndoReceipt[]>([]);
  const [undoActivity, setUndoActivity] = useState({ pending: false, uncertain: false });
  const currentItems = useRef(new Map(items.map(item => [item.catalogId, item])));
  currentItems.current = new Map(items.map(item => [item.catalogId, item]));
  const [resultsByCatalog, setResultsByCatalog] = useState<
    Array<{
      id: string;
      name: string;
      ok: boolean;
      restored?: boolean;
      unknown?: boolean;
      error?: string;
    }>
  >([]);
  const flow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const bulkFlowId = useRef<string | undefined>(undefined);
  const [delivery, setDelivery] = useState<{
    flow: ReturnType<typeof beginCatalogUiFlow>;
    failed: boolean;
    unknown: boolean;
  } | null>(null);
  useEffect(() => {
    flow.current = beginCatalogUiFlow('bulk', { count: items.length });
    bulkFlowId.current = flow.current.id;
    return () => flow.current?.cancel();
  }, []);
  useEffect(() => {
    onDirtyChange?.(
      pending || undoActivity.pending || undoActivity.uncertain || Object.keys(draft).length > 0
    );
  }, [draft, pending, undoActivity, onDirtyChange]);
  useEffect(() => {
    if (!pending && !undoActivity.pending && !undoActivity.uncertain && !Object.keys(draft).length)
      return;
    const prevent = (event: BeforeUnloadEvent) => {
      if (!mounted.current || privateCacheEpoch() !== scopeEpoch) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [draft, pending, undoActivity, scopeEpoch]);
  useEffect(() => {
    if (!delivery) return;
    // Passive effects run after the result list and counts have committed.
    delivery.flow.stage('result_visible');
    if (delivery.failed) delivery.flow.fail(delivery.unknown ? 'UNKNOWN' : 'SAVE_FAILED');
    else delivery.flow.complete();
  }, [delivery]);
  useEffect(() => {
    onPendingChange?.(pending || undoActivity.pending);
  }, [pending, undoActivity.pending, onPendingChange]);
  useEffect(
    () => () => {
      onPendingChange?.(false);
    },
    [onPendingChange]
  );
  const confirmedIds = useRef(new Set<string>());
  const baselineItems = useRef(new Map(items.map(item => [item.catalogId, item])));
  if (!Object.keys(draft).length && !pending)
    baselineItems.current = new Map(items.map(item => [item.catalogId, item]));
  const unknownIds = useRef(new Set<string>());
  const uncertain = unknownIds.current.size > 0 || undoActivity.uncertain;
  useEffect(() => {
    onUncertainChange?.(uncertain);
  }, [uncertain, onUncertainChange]);
  useEffect(() => () => onUncertainChange?.(false), [onUncertainChange]);
  const readControllers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const controller of readControllers.current) controller.abort();
    },
    []
  );
  const locked =
    pending || unknownIds.current.size > 0 || undoActivity.pending || undoActivity.uncertain;
  class UnknownSave extends Error {}
  const saveItem = async (item: Item): Promise<CatalogSnapshot> => {
    const active = () => scopeActive() && currentItems.current.has(item.catalogId);
    if (!active()) throw privateCacheSuperseded();
    const controller = new AbortController();
    readControllers.current.add(controller);
    try {
      const outcome = await saveCatalogProfile({
        base: { profile: item.profile, interval: item.interval },
        patch: draft,
        write: () => save(item.catalogId, item.profile.version, draft),
        read: read ? signal => read(item.catalogId, { signal }) : undefined,
        readOnly: unknownIds.current.has(item.catalogId),
        signal: controller.signal,
        canContinue: active,
        onStage: stage => flow.current?.stage(stage)
      });
      if (!active()) throw privateCacheSuperseded();
      if (outcome.kind === 'confirmed') {
        unknownIds.current.delete(item.catalogId);
        if (
          (currentItems.current.get(item.catalogId)?.profile.version ?? 0) >
          outcome.snapshot.profile.version
        ) {
          flow.current?.stage('conflict');
          throw new TeamApiError('STALE_RESULT', false);
        }
        return outcome.snapshot;
      }
      if (outcome.kind === 'unknown') {
        unknownIds.current.add(item.catalogId);
        throw new UnknownSave();
      }
      unknownIds.current.delete(item.catalogId);
      throw outcome.kind === 'conflict' ? new TeamApiError('STALE_RESULT', false) : outcome.error;
    } finally {
      readControllers.current.delete(controller);
    }
  };
  const errorText = (cause: unknown) =>
    cause instanceof UnknownSave ? t('catalogIconsUnknown') : teamErrorMessageFor(cause, t);
  const resetResults = () => {
    baselineItems.current = new Map(items.map(item => [item.catalogId, item]));
    confirmedIds.current.clear();
    setUndoReceipts([]);
    setResultsByCatalog([]);
    setSuccessCount(0);
    setFailures([]);
  };
  const keys = Object.keys(draft) as (keyof CatalogUpdateProfilePatch)[];
  const changesItem = (item: Item) =>
    !profilePatchMatches({ profile: item.profile, interval: item.interval }, draft);
  const changedItems = items
    .map(item => baselineItems.current.get(item.catalogId) ?? item)
    .filter(item => !confirmedIds.current.has(item.catalogId) && changesItem(item));
  const affected = changedItems.length;
  const currentInterval = items.every(item => item.interval === items[0]?.interval)
    ? (items[0]?.interval ?? null)
    : 'mixed';
  const firstSchedule = items[0]?.profile.schedule ?? null;
  const mixedSchedule = !items.every(item => {
    const value = item.profile.schedule ?? null;
    return (
      value?.time === firstSchedule?.time &&
      value?.weekday === firstSchedule?.weekday &&
      value?.timeZone === firstSchedule?.timeZone
    );
  });
  const currentSchedule = mixedSchedule ? null : firstSchedule;
  const apply = async () => {
    if (
      !scopeActive() ||
      applyLocked.current ||
      !keys.length ||
      !affected ||
      pending ||
      undoActivity.pending ||
      undoActivity.uncertain
    )
      return;
    applyLocked.current = true;
    onPendingChange?.(true);
    try {
      // A retry gets its own attempt; completed earlier results remain visible.
      if (!flow.current)
        flow.current = beginCatalogUiFlow('bulk', {
          count: changedItems.length,
          parentFlowId: bulkFlowId.current
        });
      const attemptFlow = flow.current;
      attemptFlow.stage(
        changedItems.every(item => unknownIds.current.has(item.catalogId))
          ? 'readback_requested'
          : 'save_requested'
      );
      setPending(true);
      setFailures([]);
      const appliedPatch = draft;
      const results: PromiseSettledResult<CatalogSnapshot>[] = new Array(changedItems.length);
      let nextIndex = 0;
      // Keep large selections from opening hundreds of simultaneous writes.
      await Promise.all(
        Array.from({ length: Math.min(4, changedItems.length) }, async () => {
          while (scopeActive() && nextIndex < changedItems.length) {
            const index = nextIndex++;
            const item = changedItems[index]!;
            try {
              results[index] = {
                status: 'fulfilled',
                value: await saveItem(item)
              };
            } catch (reason) {
              results[index] = { status: 'rejected', reason };
            }
          }
        })
      );
      if (!scopeActive()) {
        attemptFlow.cancel();
        return;
      }
      const failed = results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [`${changedItems[index]?.name}: ${errorText(result.reason)}`]
          : []
      );
      setFailures(failed);
      const nextResults = results.map((result, index) => ({
        id: changedItems[index]!.catalogId,
        name: changedItems[index]!.name,
        ok: result.status === 'fulfilled',
        unknown: result.status === 'rejected' && result.reason instanceof UnknownSave,
        error: result.status === 'rejected' ? errorText(result.reason) : undefined
      }));
      setResultsByCatalog(previous => {
        const byId = new Map(previous.map(result => [result.id, result]));
        nextResults.forEach(result => byId.set(result.id, result));
        return [...byId.values()];
      });
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') confirmedIds.current.add(changedItems[index]!.catalogId);
      });
      setUndoReceipts(previous => {
        const byId = new Map(previous.map(receipt => [receipt.catalogId, receipt]));
        results.forEach((result, index) => {
          if (result.status !== 'fulfilled') return;
          const item = changedItems[index]!;
          byId.set(item.catalogId, {
            catalogId: item.catalogId,
            name: item.name,
            before: { profile: item.profile, interval: item.interval },
            after: result.value,
            patch: appliedPatch
          });
        });
        return [...byId.values()];
      });
      setSuccessCount(confirmedIds.current.size);
      if (results.some(result => result.status === 'fulfilled'))
        attemptFlow.stage('save_confirmed');
      setDelivery({
        flow: attemptFlow,
        failed: failed.length > 0,
        unknown: results.some(
          result => result.status === 'rejected' && result.reason instanceof UnknownSave
        )
      });
      flow.current = null;
      if (!failed.length) setDraft({});
      setPending(false);
      onSaved();
    } finally {
      applyLocked.current = false;
      if (scopeActive()) {
        setPending(false);
        onPendingChange?.(false);
      }
    }
  };
  return (
    <div className="team-updater-profile" role="group" aria-label={t('catalogUpdaterBulkSettings')}>
      <strong>{t('catalogUpdaterBulkSettings')}</strong>
      <p className="field-hint">{t('catalogUpdaterBulkCount', { count: items.length })}</p>
      {mode !== 'restitch' && (
        <>
          <div className="team-updater-filter-field">
            <span>
              {t('catalogUpdaterFilterInterval')} · {intervalLabel(currentInterval, t)}
              {mixedSchedule ? ` · ${t('catalogUpdaterMixed')}` : ''} ·{' '}
              {draft.updateInterval === undefined
                ? t('catalogUpdaterBulkKeep')
                : intervalLabel(draft.updateInterval, t)}
            </span>
            {draft.updateInterval !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => {
                  resetResults();
                  setDraft(current => {
                    const next = { ...current };
                    delete next.updateInterval;
                    delete next.schedule;
                    return next;
                  });
                }}
              >
                {t('catalogUpdaterBulkKeep')}
              </Button>
            )}
          </div>
          <UpdaterIntervalPicker
            clockOffsetMs={clockOffsetMs}
            value={draft.updateInterval === undefined ? currentInterval : draft.updateInterval}
            label={t('catalogUpdaterBulkIntervalTogether')}
            disabled={locked}
            schedule={draft.schedule === undefined ? currentSchedule : draft.schedule}
            onSaveSchedule={async (value, schedule) => {
              resetResults();
              setDraft(current => ({ ...current, updateInterval: value, schedule }));
            }}
            onChange={value => {
              resetResults();
              setDraft(current => ({ ...current, updateInterval: value }));
            }}
          />
        </>
      )}
      <div className="team-updater-profile-choices">
        {FIELDS.filter(
          ([field]) => mode === 'all' || (mode === 'restitch' && field === 'restitch')
        ).map(([field, label]) => (
          <div key={field} className="team-updater-filter-field">
            <span>
              {t(label)} ·{' '}
              {items.every(item => item.profile[field] === items[0]?.profile[field])
                ? items[0]?.profile[field]
                  ? t('catalogUpdaterBulkOn')
                  : t('catalogUpdaterBulkOff')
                : t('catalogUpdaterMixed')}
            </span>
            <SelectMenu
              id={`bulk-${field}`}
              disabled={locked}
              label={`${t(label)} · ${
                items.every(item => item.profile[field] === items[0]?.profile[field])
                  ? items[0]?.profile[field]
                    ? t('catalogUpdaterBulkOn')
                    : t('catalogUpdaterBulkOff')
                  : t('catalogUpdaterMixed')
              }`}
              placeholder={t('catalogUpdaterBulkKeep')}
              errorLabel={t(label)}
              value={draft[field] === undefined ? 'keep' : draft[field] ? 'on' : 'off'}
              options={[
                { value: 'keep', label: t('catalogUpdaterBulkKeep') },
                { value: 'on', label: t('catalogUpdaterBulkOn') },
                { value: 'off', label: t('catalogUpdaterBulkOff') }
              ]}
              onChange={value => {
                resetResults();
                setDraft(current => {
                  const next = { ...current };
                  if (value === 'keep') delete next[field];
                  else next[field] = value === 'on';
                  return next;
                });
              }}
            />
          </div>
        ))}
      </div>
      <p className="field-hint">
        {keys.length
          ? t('catalogUpdaterBulkPreview', {
              count: affected,
              changes: FIELDS.filter(([field]) => draft[field] !== undefined)
                .map(
                  ([field, label]) =>
                    `${t(label)}: ${draft[field] ? t('catalogUpdaterBulkOn') : t('catalogUpdaterBulkOff')}`
                )
                .concat(
                  draft.updateInterval === undefined
                    ? []
                    : [
                        `${t('catalogUpdaterFilterInterval')}: ${intervalLabel(draft.updateInterval, t)}`
                      ]
                )
                .join(', ')
            })
          : t('catalogUpdaterBulkKeepHint')}
      </p>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={
          !keys.length || !affected || pending || undoActivity.pending || undoActivity.uncertain
        }
        onClick={() => void apply()}
      >
        {t(unknownIds.current.size > 0 ? 'catalogIconsCheck' : 'catalogUpdaterSaveProfile')}
      </Button>
      {successCount > 0 && (
        <p role="status">{t('catalogUpdaterBulkSaved', { count: successCount })}</p>
      )}
      {read && undoReceipts.length > 0 && (
        <CatalogBulkUndo
          receipts={undoReceipts}
          allowedIds={items.map(item => item.catalogId)}
          read={read}
          save={save}
          disabled={pending || unknownIds.current.size > 0}
          parentFlowId={bulkFlowId.current}
          onStart={() => setDraft({})}
          onConfirmed={receipt => {
            confirmedIds.current.delete(receipt.catalogId);
            setSuccessCount(confirmedIds.current.size);
            setResultsByCatalog(current =>
              current.map(result =>
                result.id === receipt.catalogId ? { ...result, restored: true } : result
              )
            );
          }}
          onSaved={onSaved}
          onActivityChange={setUndoActivity}
        />
      )}
      {failures.length > 0 && (
        <div className="team-inline-error" role="alert">
          {failures.map(failure => (
            <p key={failure}>{failure}</p>
          ))}
        </div>
      )}
      {resultsByCatalog.length > 0 && (
        <details>
          <summary>{t('catalogUpdaterBulkResults', { count: resultsByCatalog.length })}</summary>
          <ol>
            {resultsByCatalog.map(result => (
              <li key={result.id}>
                {result.name}:{' '}
                {result.unknown
                  ? t('catalogIconsUnknown')
                  : result.restored
                    ? t('catalogUpdaterBulkResultRestored')
                    : result.ok
                      ? t('catalogUpdaterBulkResultSaved')
                      : `${t('catalogUpdaterBulkResultFailed')} · ${result.error}`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
