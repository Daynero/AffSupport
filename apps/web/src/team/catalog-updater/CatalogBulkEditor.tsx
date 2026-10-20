import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { Button, SelectMenu } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import type { CatalogUpdaterInterval } from '../../api/team';
import { beginCatalogUiFlow } from './analytics';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';

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
  onSaved,
  onDirtyChange,
  onPendingChange,
  mode = 'all'
}: {
  mode?: 'all' | 'restitch' | 'schedule';
  items: Item[];
  save: (
    catalogId: string,
    expectedVersion: number,
    patch: CatalogUpdateProfilePatch
  ) => Promise<CatalogUpdateProfile>;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CatalogUpdateProfilePatch>({});
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [successCount, setSuccessCount] = useState(0);
  const [resultsByCatalog, setResultsByCatalog] = useState<
    Array<{ id: string; name: string; ok: boolean; error?: string }>
  >([]);
  const flow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const bulkFlowId = useRef<string | undefined>(undefined);
  const [delivery, setDelivery] = useState<{
    flow: ReturnType<typeof beginCatalogUiFlow>;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    flow.current = beginCatalogUiFlow('bulk', { count: items.length });
    bulkFlowId.current = flow.current.id;
    return () => flow.current?.cancel();
  }, []);
  useEffect(() => {
    onDirtyChange?.(pending || Object.keys(draft).length > 0);
  }, [draft, pending, onDirtyChange]);
  useEffect(() => {
    if (!pending && !Object.keys(draft).length) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [draft, pending]);
  useEffect(() => {
    if (!delivery) return;
    // Passive effects run after the result list and counts have committed.
    delivery.flow.stage('result_visible');
    if (delivery.failed) delivery.flow.fail('SAVE_FAILED');
    else delivery.flow.complete();
  }, [delivery]);
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(
    () => () => {
      onPendingChange?.(false);
    },
    [onPendingChange]
  );
  const confirmedIds = useRef(new Set<string>());
  const resetResults = () => {
    confirmedIds.current.clear();
    setResultsByCatalog([]);
    setSuccessCount(0);
    setFailures([]);
  };
  const keys = Object.keys(draft) as (keyof CatalogUpdateProfilePatch)[];
  const changesItem = (item: Item) =>
    (draft.updateInterval !== undefined && draft.updateInterval !== item.interval) ||
    FIELDS.some(([field]) => draft[field] !== undefined && draft[field] !== item.profile[field]);
  const changedItems = items.filter(
    item => !confirmedIds.current.has(item.catalogId) && changesItem(item)
  );
  const affected = changedItems.length;
  const currentInterval = items.every(item => item.interval === items[0]?.interval)
    ? (items[0]?.interval ?? null)
    : 'mixed';
  const apply = async () => {
    if (!keys.length || !affected || pending) return;
    // A retry gets its own attempt; completed earlier results remain visible.
    if (!flow.current)
      flow.current = beginCatalogUiFlow('bulk', {
        count: changedItems.length,
        parentFlowId: bulkFlowId.current
      });
    const attemptFlow = flow.current;
    attemptFlow.stage('save_requested');
    setPending(true);
    setFailures([]);
    const results: PromiseSettledResult<CatalogUpdateProfile>[] = new Array(changedItems.length);
    let nextIndex = 0;
    // Keep large selections from opening hundreds of simultaneous writes.
    await Promise.all(
      Array.from({ length: Math.min(4, changedItems.length) }, async () => {
        while (nextIndex < changedItems.length) {
          const index = nextIndex++;
          const item = changedItems[index]!;
          try {
            results[index] = {
              status: 'fulfilled',
              value: await save(item.catalogId, item.profile.version, draft)
            };
          } catch (reason) {
            results[index] = { status: 'rejected', reason };
          }
        }
      })
    );
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`${changedItems[index]?.name}: ${teamErrorMessageFor(result.reason, t)}`]
        : []
    );
    setFailures(failed);
    const nextResults = results.map((result, index) => ({
      id: changedItems[index]!.catalogId,
      name: changedItems[index]!.name,
      ok: result.status === 'fulfilled',
      error: result.status === 'rejected' ? teamErrorMessageFor(result.reason, t) : undefined
    }));
    setResultsByCatalog(previous => {
      const byId = new Map(previous.map(result => [result.id, result]));
      nextResults.forEach(result => byId.set(result.id, result));
      return [...byId.values()];
    });
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') confirmedIds.current.add(changedItems[index]!.catalogId);
    });
    setSuccessCount(confirmedIds.current.size);
    if (results.some(result => result.status === 'fulfilled')) attemptFlow.stage('save_confirmed');
    setDelivery({ flow: attemptFlow, failed: failed.length > 0 });
    flow.current = null;
    if (!failed.length) setDraft({});
    setPending(false);
    onSaved();
  };
  return (
    <div className="team-updater-profile" role="group" aria-label={t('catalogUpdaterBulkSettings')}>
      <strong>{t('catalogUpdaterBulkSettings')}</strong>
      <p className="field-hint">{t('catalogUpdaterBulkCount', { count: items.length })}</p>
      {mode !== 'restitch' && (
        <>
          <div className="team-updater-filter-field">
            <span>
              {t('catalogUpdaterFilterInterval')} · {intervalLabel(currentInterval, t)} ·{' '}
              {draft.updateInterval === undefined
                ? t('catalogUpdaterBulkKeep')
                : intervalLabel(draft.updateInterval, t)}
            </span>
            {draft.updateInterval !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  resetResults();
                  setDraft(current => {
                    const next = { ...current };
                    delete next.updateInterval;
                    return next;
                  });
                }}
              >
                {t('catalogUpdaterBulkKeep')}
              </Button>
            )}
          </div>
          <UpdaterIntervalPicker
            value={draft.updateInterval === undefined ? currentInterval : draft.updateInterval}
            label={t('catalogUpdaterBulkIntervalTogether')}
            disabled={pending}
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
              disabled={pending}
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
        disabled={!keys.length || !affected || pending}
        onClick={() => void apply()}
      >
        {t('catalogUpdaterSaveProfile')}
      </Button>
      {successCount > 0 && (
        <p role="status">{t('catalogUpdaterBulkSaved', { count: successCount })}</p>
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
                {result.ok
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
