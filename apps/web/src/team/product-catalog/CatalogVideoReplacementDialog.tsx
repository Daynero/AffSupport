import { useEffect, useRef, useState } from 'react';
import type {
  CatalogVideoReplacementContext,
  CatalogVideoReplacementReceipt
} from '@video-compressor/shared';
import { Button, Checkbox, LoadingState, Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { TeamApiError } from '../../api/team';
import {
  catalogVideoReplacementApi,
  type CatalogVideoReplacementClient
} from '../../api/catalog-video-replacement';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { WorkspaceMutationJournal } from '../workspace/mutationJournal';
import { TaskAttachmentPicker, type TaskAttachmentCandidate } from '../tasks/TaskAttachmentPicker';
import { teamErrorMessageFor } from '../errors';
import { withReadDeadline } from '../readCoordinator';
import { useVisibleSerialRead } from '../catalog/useVisibleSerialRead';
import { beginCatalogUiFlow, type CatalogUiFlow } from '../catalog-updater/analytics';

export interface CatalogVideoReplacementDialogProps {
  teamId: string;
  catalogId: string;
  open: boolean;
  disabled?: boolean;
  revision?: string | null;
  onClose: () => void;
  onChanged: () => void;
  client?: CatalogVideoReplacementClient;
}
export function CatalogVideoReplacementDialog(props: CatalogVideoReplacementDialogProps) {
  const epoch = usePrivateCacheEpoch();
  return <Session key={`${epoch}:${props.teamId}:${props.catalogId}`} {...props} />;
}
function Session({
  teamId,
  catalogId,
  open,
  disabled = false,
  revision,
  client = catalogVideoReplacementApi,
  onClose,
  onChanged
}: CatalogVideoReplacementDialogProps) {
  const { t } = useI18n();
  const actor = privateCacheActor(),
    epoch = privateCacheEpoch();
  const callbacks = useRef({ onChanged, onClose });
  callbacks.current = { onChanged, onClose };
  const [persistence] = useState(() => {
    try {
      if (!actor) throw new TeamApiError('AUTH_REQUIRED', false);
      const journal = new WorkspaceMutationJournal(
        'catalog-video-replacement',
        actor,
        teamId,
        localStorage
      );
      return {
        journal,
        id: journal.list().find(v => v.materialIds.includes(catalogId))?.id ?? null,
        error: null
      };
    } catch (error) {
      return { journal: null, id: null, error };
    }
  });
  const [context, setContext] = useState<CatalogVideoReplacementContext | null>(null);
  const [receipt, setReceipt] = useState<CatalogVideoReplacementReceipt | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(persistence.id);
  const [selected, setSelected] = useState<TaskAttachmentCandidate | null>(null);
  const [move, setMove] = useState(true);
  const [notSubmitted, setNotSubmitted] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(persistence.error);
  const mounted = useRef(true),
    locked = useRef(false),
    delivered = useRef<string | null>(null);
  const flow = useRef<CatalogUiFlow | null>(null);
  const [readTick, setReadTick] = useState(0);
  const writeEpoch = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const pendingRef = useRef(pendingId);
  pendingRef.current = pendingId;
  const clearRetry = () => {
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
  };
  const wake = () => {
    clearRetry();
    retryCount.current = 0;
    setReadTick(n => n + 1);
  };
  const owns = () =>
    mounted.current && privateCacheEpoch() === epoch && privateCacheActor() === actor;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flow.current?.cancel();
      clearRetry();
    };
  }, []);
  const observe = (r: CatalogVideoReplacementReceipt) => {
    if (!owns()) return;
    setReceipt(r);
    setNotSubmitted(false);
    pendingRef.current = r.state === 'confirmed' ? null : r.requestId;
    setPendingId(pendingRef.current);
    if (r.state === 'confirmed') persistence.journal?.confirmed(r.requestId);
  };
  useEffect(() => {
    if (!open || receipt?.state !== 'confirmed' || delivered.current === receipt.requestId) return;
    delivered.current = receipt.requestId;
    flow.current?.complete();
    flow.current = null;
    callbacks.current.onChanged();
  }, [receipt, open]);
  useEffect(() => {
    if (open || receipt?.state !== 'confirmed') return;
    setReceipt(null);
    setContext(null);
    setSelected(null);
    setMove(true);
    setNotSubmitted(false);
  }, [open, receipt]);
  const refresh = async (signal: AbortSignal) => {
    if (!open || locked.current || receipt?.state === 'confirmed') return;
    const requestedEpoch = writeEpoch.current;
    const current = () => owns() && !signal.aborted && requestedEpoch === writeEpoch.current;
    if (!actor || persistence.error)
      throw persistence.error ?? new TeamApiError('AUTH_REQUIRED', false);
    const scope = { teamId, catalogId, expectedActorId: actor };
    const id =
      pendingRef.current ??
      persistence.journal?.list().find(v => v.materialIds.includes(catalogId))?.id;
    if (id) {
      if (!flow.current)
        flow.current = beginCatalogUiFlow('replace_video', { parentFlowId: id, count: 1 });
      flow.current.stage('readback_requested');
      const r = await client.status({ ...scope, requestId: id }, signal);
      if (!current()) return;
      setError(null);
      if (r) {
        observe(r);
        return;
      }
      persistence.journal?.confirmed(id);
      flow.current?.fail('NOT_FOUND');
      flow.current = null;
      pendingRef.current = null;
      setPendingId(null);
      setReceipt(null);
      setNotSubmitted(true);
    }
    const c = await client.context(scope, signal);
    if (!current()) return;
    setError(null);
    setContext(c);
    if (c.active) observe(c.active);
  };
  // The existing catalog registry supplies Realtime/heartbeat revisions. A short,
  // bounded catch-up burst covers lost replies and missed signals, with one serial
  // read owner and no write replay. Hidden tabs defer until visibility returns.
  useVisibleSerialRead({
    scopeKey: `${epoch}:${teamId}:${catalogId}:${open}`,
    client,
    revision: readTick,
    immediate: true,
    bindScope: true,
    read: async signal => {
      clearRetry();
      if (!open || locked.current) return;
      let failed = false;
      try {
        await withReadDeadline(refresh, signal);
      } catch (e) {
        if (owns() && !signal.aborted) {
          failed = true;
          setError(e);
        }
      }
      if (!owns() || signal.aborted || !open || persistence.error || locked.current) return;
      const delays = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];
      if ((pendingRef.current || failed) && retryCount.current < delays.length) {
        retry.current = setTimeout(() => {
          retry.current = null;
          setReadTick(n => n + 1);
        }, delays[retryCount.current++]!);
      }
    }
  });
  useEffect(() => {
    if (!open) {
      clearRetry();
      return;
    }
    wake();
    const changed = () => wake();
    const storageChanged = (event: StorageEvent) => {
      if (persistence.journal?.ownsStorageKey(event.key)) wake();
    };
    window.addEventListener('focus', changed);
    window.addEventListener('online', changed);
    window.addEventListener('storage', storageChanged);
    return () => {
      clearRetry();
      window.removeEventListener('focus', changed);
      window.removeEventListener('online', changed);
      window.removeEventListener('storage', storageChanged);
    };
  }, [open, revision]);
  const submit = async () => {
    if (
      locked.current ||
      disabled ||
      pendingId ||
      !selected ||
      !context ||
      context.blockedReason ||
      !actor ||
      !persistence.journal
    )
      return;
    locked.current = true;
    writeEpoch.current += 1;
    clearRetry();
    setBusy(true);
    setError(null);
    setNotSubmitted(false);
    let id: string | null = null;
    try {
      const previous = persistence.journal.list().find(v => v.materialIds.includes(catalogId));
      if (previous) {
        pendingRef.current = previous.id;
        setPendingId(previous.id);
        return;
      }
      // A different tab's durable identity can only be checked, never assigned to this draft.
      id = persistence.journal.acquire([catalogId], { fresh: true }).id;
      pendingRef.current = id;
      setPendingId(id);
      flow.current = beginCatalogUiFlow('replace_video', { parentFlowId: id, count: 1 });
      flow.current.stage('save_requested');
      const r = await withReadDeadline(
        signal =>
          client.submit(
            {
              teamId,
              catalogId,
              expectedActorId: actor,
              requestId: id!,
              newVideoId: selected.id,
              expectedVersion: context.version,
              moveToVideoFolder: move
            },
            signal
          ),
        new AbortController().signal
      );
      if (!owns()) return;
      flow.current.stage('save_confirmed');
      observe(r);
      callbacks.current.onChanged();
    } catch (e) {
      if (!owns()) return;
      setError(e);
      flow.current?.fail(e instanceof TeamApiError ? e.code : 'UNKNOWN');
      flow.current = null;
      if (
        id &&
        e instanceof TeamApiError &&
        [
          'PERMISSION_DENIED',
          'AUTH_REQUIRED',
          'INVALID_INPUT',
          'STALE_RESULT',
          'SOURCE_CHANGED',
          'NOT_FOUND',
          'CATALOG_PUBLICATION_PENDING',
          'WRONG_STATE'
        ].includes(e.code)
      ) {
        persistence.journal?.confirmed(id);
        pendingRef.current = null;
        setPendingId(null);
        setContext(null);
      }
    } finally {
      if (owns()) setBusy(false);
      locked.current = false;
      if (owns()) wake();
    }
  };
  if (!open) return null;
  const pending = Boolean(pendingId || (receipt && receipt.state !== 'confirmed'));
  return (
    <Modal nested size="md" title={t('catalogReplaceVideoTitle')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-label text-muted">{t('catalogReplaceVideoDescription')}</p>
        {Boolean(error) && <p role="alert">{teamErrorMessageFor(error, t)}</p>}
        {notSubmitted && <p role="status">{t('catalogReplaceVideoNotSubmitted')}</p>}
        {!context && !pending && !error && (
          <LoadingState count={1} label={t('catalogSettingsLoading')} />
        )}
        {receipt?.state === 'confirmed' ? (
          <p role="status">{t('catalogReplaceVideoDone')}</p>
        ) : pending ? (
          <>
            <p role="status">
              {t(
                receipt?.state === 'moving'
                  ? 'catalogReplaceVideoMoving'
                  : 'catalogReplaceVideoPending'
              )}
            </p>
            {receipt?.errorCode && (
              <p role="alert">{teamErrorMessageFor({ code: receipt.errorCode }, t)}</p>
            )}
          </>
        ) : context ? (
          <>
            <div>
              <span className="text-caption text-muted">{t('catalogReplaceVideoCurrent')}</span>
              <p className="break-words">{context.currentVideoName}</p>
            </div>
            {context.blockedReason ? (
              <p role="status">
                {t(
                  context.blockedReason === 'legacy'
                    ? 'catalogReplaceVideoNeedsPublication'
                    : 'catalogReplaceVideoBusy'
                )}
              </p>
            ) : (
              <>
                <TaskAttachmentPicker
                  teamId={teamId}
                  single
                  attachedMaterialIds={new Set([context.currentVideoId])}
                  accept={v => v.category === 'video' && v.id !== context.currentVideoId}
                  title={t('catalogReplaceVideoChoose')}
                  confirmLabel={() => t('catalogReplaceVideoChoose')}
                  trigger={show => (
                    <Button
                      className="max-w-full"
                      variant="outline"
                      disabled={busy || disabled}
                      title={selected?.name}
                      onClick={show}
                    >
                      <span className="min-w-0 truncate">
                        {selected?.name ?? t('catalogReplaceVideoChoose')}
                      </span>
                    </Button>
                  )}
                  onAdd={items => setSelected(items[0] ?? null)}
                />
                <Checkbox
                  checked={move}
                  disabled={busy || disabled}
                  onChange={setMove}
                  label={t('catalogReplaceVideoMove')}
                />
                <p className="text-caption text-muted">{t('catalogReplaceVideoShare')}</p>
              </>
            )}
          </>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('catalogUpdaterClose')}
          </Button>
          {!pending && receipt?.state !== 'confirmed' && context && !context.blockedReason && (
            <Button
              color="primary"
              disabled={!selected || busy || disabled}
              loading={busy}
              onClick={() => void submit()}
            >
              {t('catalogReplaceVideoTitle')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
