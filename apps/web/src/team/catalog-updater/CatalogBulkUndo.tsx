import { privateCacheEpoch } from '../private-cache-scope';
import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { TeamApiError } from '../../api/team';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { withReadDeadline } from '../readCoordinator';
import { beginCatalogUiFlow, type CatalogUiFlow, type CatalogUiFailure } from './analytics';
import { profilePatchMatches } from './profilePatchMatches';
import { saveCatalogProfile } from './saveCatalogProfile';
import type { CatalogSnapshot } from './useCatalogInlineChanges';

export interface CatalogBulkUndoReceipt {
  catalogId: string;
  name: string;
  before: CatalogSnapshot;
  after: CatalogSnapshot;
  patch: CatalogUpdateProfilePatch;
}

type Result = {
  phase: 'working' | 'restored' | 'conflict' | 'unknown' | 'failed';
  error?: unknown;
};
const keyFor = (receipt: CatalogBulkUndoReceipt) =>
  `${receipt.catalogId}:${receipt.after.profile.version}`;

/** Restore only fields this batch changed; frequency and its calendar form one setting. */
function restorePatch(receipt: CatalogBulkUndoReceipt): CatalogUpdateProfilePatch {
  const patch: CatalogUpdateProfilePatch = {};
  if (receipt.patch.videoVariantCount !== undefined)
    patch.videoVariantCount = receipt.before.profile.videoVariantCount ?? 1;
  for (const key of [
    'restitch',
    'randomLinkVariation',
    'refreshImages',
    'refreshTexts',
    'growProducts'
  ] as const)
    if (receipt.patch[key] !== undefined) patch[key] = receipt.before.profile[key];
  if (receipt.patch.updateInterval !== undefined || receipt.patch.schedule !== undefined) {
    patch.updateInterval = receipt.before.interval;
    patch.schedule = receipt.before.profile.schedule ?? null;
  }
  return patch;
}

/** A verified per-item inverse, never a replay of an uncertain write. */
export function CatalogBulkUndo({
  receipts,
  allowedIds,
  read,
  save,
  disabled,
  parentFlowId,
  onStart,
  onConfirmed,
  onSaved,
  onActivityChange
}: {
  receipts: CatalogBulkUndoReceipt[];
  allowedIds: string[];
  read: (id: string, options?: { signal?: AbortSignal }) => Promise<CatalogSnapshot>;
  save: (
    id: string,
    version: number,
    patch: CatalogUpdateProfilePatch
  ) => Promise<CatalogUpdateProfile>;
  disabled: boolean;
  parentFlowId?: string;
  onStart: () => void;
  onConfirmed: (receipt: CatalogBulkUndoReceipt) => void;
  onSaved: () => void;
  onActivityChange: (activity: { pending: boolean; uncertain: boolean }) => void;
}) {
  const { t } = useI18n();
  const mounted = useRef(true);
  const scopeEpoch = useRef(privateCacheEpoch()).current;
  const scopeActive = () => mounted.current && privateCacheEpoch() === scopeEpoch;
  const allowed = useRef(new Set(allowedIds));
  allowed.current = new Set(allowedIds);
  const locked = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const flows = useRef(new Set<CatalogUiFlow>());
  const unknownBases = useRef(new Map<string, CatalogSnapshot>());
  const [results, setResults] = useState<Record<string, Result>>({});
  const [pending, setPending] = useState(false);
  const [delivery, setDelivery] = useState<{
    flow: CatalogUiFlow;
    failure?: CatalogUiFailure;
  } | null>(null);
  const visible = receipts.filter(receipt => allowed.current.has(receipt.catalogId));
  const unknown = visible.some(receipt => results[keyFor(receipt)]?.phase === 'unknown');
  const candidates = visible.filter(receipt =>
    unknown
      ? results[keyFor(receipt)]?.phase === 'unknown'
      : !['restored', 'conflict'].includes(results[keyFor(receipt)]?.phase ?? 'ready')
  );

  useEffect(() => {
    onActivityChange({ pending, uncertain: unknown });
  }, [pending, unknown, onActivityChange]);
  useEffect(() => () => onActivityChange({ pending: false, uncertain: false }), [onActivityChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
      for (const flow of flows.current) flow.cancel();
    };
  }, []);
  useEffect(() => {
    if (!delivery) return;
    delivery.flow.stage('result_visible');
    if (delivery.failure) delivery.flow.fail(delivery.failure);
    else delivery.flow.complete();
    flows.current.delete(delivery.flow);
  }, [delivery]);

  const apply = async () => {
    if (!scopeActive() || disabled || locked.current || !candidates.length) return;
    locked.current = true;
    setPending(true);
    onActivityChange({ pending: true, uncertain: unknown });
    onStart();
    const flow = beginCatalogUiFlow('bulk', { count: candidates.length, parentFlowId });
    flows.current.add(flow);
    flow.stage(unknown ? 'readback_requested' : 'undo_requested');
    const settled: Result[] = [];
    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, candidates.length) }, async () => {
          while (scopeActive() && next < candidates.length) {
            const receipt = candidates[next++]!;
            const key = keyFor(receipt);
            const active = () => scopeActive() && allowed.current.has(receipt.catalogId);
            if (!active()) continue;
            const controller = new AbortController();
            controllers.current.add(controller);
            setResults(current => ({ ...current, [key]: { phase: 'working' } }));
            let result: Result;
            try {
              let base = unknownBases.current.get(key);
              const readOnly = Boolean(base);
              if (!base) {
                base = await withReadDeadline(
                  signal => read(receipt.catalogId, { signal }),
                  controller.signal
                );
                if (!active()) continue;
                if (base.profile.catalogId !== receipt.catalogId)
                  throw new TeamApiError('INVALID_RESPONSE', false);
                if (
                  base.profile.version !== receipt.after.profile.version ||
                  !profilePatchMatches(base, receipt.patch)
                ) {
                  result = { phase: 'conflict', error: new TeamApiError('STALE_RESULT', false) };
                  flow.stage('conflict', 'CONFLICT');
                  setResults(current => ({ ...current, [key]: result }));
                  settled.push(result);
                  continue;
                }
              }
              if (!active()) continue;
              const expected = base;
              const patch = restorePatch(receipt);
              const outcome = await saveCatalogProfile({
                base: expected,
                patch,
                readOnly,
                write: () => save(receipt.catalogId, expected.profile.version, patch),
                read: signal => read(receipt.catalogId, { signal }),
                signal: controller.signal,
                canContinue: active,
                onStage: stage => flow.stage(stage)
              });
              if (!active()) continue;
              if (outcome.kind === 'confirmed') {
                unknownBases.current.delete(key);
                result = { phase: 'restored' };
                onConfirmed(receipt);
                flow.stage('save_confirmed');
              } else if (outcome.kind === 'unknown') {
                unknownBases.current.set(key, expected);
                result = { phase: 'unknown', error: outcome.error };
                flow.stage('readback_requested', teamErrorCodeOf(outcome.error) ?? 'UNKNOWN');
              } else {
                unknownBases.current.delete(key);
                result = {
                  phase: outcome.kind === 'conflict' ? 'conflict' : 'failed',
                  error: outcome.error
                };
                flow.stage(
                  outcome.kind === 'conflict' ? 'conflict' : 'save_requested',
                  outcome.kind === 'conflict'
                    ? 'CONFLICT'
                    : (teamErrorCodeOf(outcome.error) ?? 'SAVE_FAILED')
                );
              }
            } catch (error) {
              if (!active()) continue;
              // A failed preflight sent no mutation: a later click may read and try again.
              result = { phase: 'failed', error };
              flow.stage('readback_requested', teamErrorCodeOf(error) ?? 'READ_FAILED');
            } finally {
              controllers.current.delete(controller);
            }
            setResults(current => ({ ...current, [key]: result }));
            settled.push(result);
          }
        })
      );
      if (!scopeActive()) {
        flow.cancel();
        return;
      }
      if (settled.length) {
        const failures = settled.filter(item => item.phase !== 'restored');
        setDelivery({
          flow,
          failure: failures.some(item => item.phase === 'unknown')
            ? 'UNKNOWN'
            : failures.length && failures.every(item => item.phase === 'conflict')
              ? 'CONFLICT'
              : failures.length
                ? 'SAVE_FAILED'
                : undefined
        });
        onSaved();
      } else {
        flow.cancel();
        flows.current.delete(flow);
      }
    } finally {
      locked.current = false;
      if (scopeActive()) setPending(false);
    }
  };

  const restored = visible.filter(receipt => results[keyFor(receipt)]?.phase === 'restored').length;
  const observed = visible.filter(receipt => results[keyFor(receipt)]);
  return (
    <div className="grid gap-2">
      {candidates.length > 0 && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || pending}
          onClick={() => void apply()}
        >
          {t(unknown ? 'catalogIconsCheck' : 'catalogUpdaterBulkUndo')}
        </Button>
      )}
      {restored > 0 && <p role="status">{t('catalogUpdaterBulkRestored', { count: restored })}</p>}
      {observed.length > 0 && (
        <details>
          <summary>{t('catalogUpdaterBulkUndoResults', { count: observed.length })}</summary>
          <ul>
            {observed.map(receipt => {
              const result = results[keyFor(receipt)]!;
              return (
                <li key={keyFor(receipt)}>
                  <strong>{receipt.name}</strong>:{' '}
                  {result.phase === 'restored'
                    ? t('catalogUpdaterBulkResultRestored')
                    : result.phase === 'conflict'
                      ? t('catalogIconsUndoInvalid')
                      : result.phase === 'unknown'
                        ? t('catalogIconsUnknown')
                        : result.phase === 'working'
                          ? t('catalogUpdaterBulkRestoring')
                          : teamErrorMessageFor(result.error, t)}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
