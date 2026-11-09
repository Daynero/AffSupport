import {
  isCatalogForegroundAdmissionRefused,
  isCatalogForegroundPreparationFailure
} from '../../api/catalog-video-foreground';
import { recoveryInstallation } from '../../api/recovery-installation';
import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button, FormField, Input } from '../../components/ui/index';
import { teamApi, type CatalogRegistryRow } from '../../api/team';
import type { CatalogUpdaterVariantsSnapshot } from '../../api/catalog-updater-variants';
import { useI18n } from '../../i18n';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { withReadDeadline } from '../readCoordinator';
import { withCatalogCommandDeadline } from './catalogCommandCoordinator';
import { beginCatalogUiFlow } from './analytics';
import { useTeam } from '../TeamContext';
import { useOptionalAgent } from '../../AgentContext';
import { useAgentEventStream } from '../../api/useAgentEventStream';
import { toolEventUrl } from '../../api/client';
export function CatalogVideoVariationsDialog({
  teamId,
  row,
  onClose,
  onChanged
}: {
  teamId: string;
  row: CatalogRegistryRow;
  onClose(): void;
  onChanged(): void;
}) {
  const { t } = useI18n(),
    title = useId(),
    countId = useId(),
    epoch = usePrivateCacheEpoch(),
    actor = privateCacheActor();
  const { updaterRevision } = useTeam(),
    agent = useOptionalAgent();
  const [count, setCount] = useState(String(row.profile?.videoVariantCount ?? 1)),
    [snapshot, setSnapshot] = useState<CatalogUpdaterVariantsSnapshot | null>(null),
    [pending, setPending] = useState(false),
    [unknown, setUnknown] = useState<string | null>(null),
    [error, setError] = useState('');
  const mounted = useRef(false),
    busy = useRef<number | null>(null),
    serial = useRef(0),
    latest = useRef('');
  const scope = `${actor}:${epoch}:${teamId}:${row.catalogId}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const readDirty = useRef(false);
  const request = useRef<string | null>(null),
    flow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const key = actor ? `soty:catalog-video-manager:v1:${actor}:${teamId}:${row.catalogId}` : null;
  const owns = () =>
    mounted.current &&
    currentScope.current === scope &&
    privateCacheActor() === actor &&
    privateCacheEpoch() === epoch;
  const apply = (value: CatalogUpdaterVariantsSnapshot) => {
    setSnapshot(value);
    setUnknown(null);
    setCount(String(value.requestedCount));
    if (
      (value.state === 'ready' && value.publicationState === 'published') ||
      value.state === 'canceled'
    ) {
      if (key) localStorage.removeItem(key);
      request.current = null;
      onChanged();
    }
  };
  const read = async () => {
    if (!owns()) return;
    if (busy.current) {
      readDirty.current = true;
      return;
    }
    const token = ++serial.current;
    busy.current = token;
    setPending(true);
    try {
      const result = await withReadDeadline(
        signal =>
          teamApi.readCatalogUpdaterVariants(teamId, row.catalogId, request.current ?? undefined, {
            signal
          }),
        new AbortController().signal
      );
      if (!owns()) return;
      if (result) apply(result);
      else if (request.current) setUnknown(request.current);
    } catch (cause) {
      if (owns()) setError(teamErrorMessageFor(cause, t));
    } finally {
      if (busy.current === token) {
        busy.current = null;
        if (owns()) {
          setPending(false);
          if (readDirty.current) {
            readDirty.current = false;
            queueMicrotask(() => void readRef.current());
          }
        }
      }
    }
  };
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    mounted.current = true;
    readDirty.current = false;
    busy.current = null;
    setPending(false);
    request.current = null;
    setSnapshot(null);
    setUnknown(null);
    setError('');
    try {
      if (key) {
        const retained = localStorage.getItem(key);
        if (
          retained &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            retained
          )
        ) {
          request.current = retained;
          setUnknown(retained);
        }
      }
    } catch {
      setError(t('catalogPublicationStorageError'));
    }
    void readRef.current();
    return () => {
      mounted.current = false;
    };
  }, [teamId, row.catalogId, epoch, key]);
  useEffect(() => {
    if (request.current) void readRef.current();
  }, [updaterRevision]);
  useAgentEventStream<{
    type: 'team:operations';
    operations: Array<{ operationId: string; state: string }>;
  }>({
    url: request.current ? toolEventUrl('team') : null,
    channel: 'team',
    multiplexed: Boolean(agent?.capabilities?.includes('event-stream')),
    enabled: Boolean(request.current),
    onOpen: () => void readRef.current(),
    onReconnect: () => void readRef.current(),
    onMessage: event => {
      if (event.type !== 'team:operations') return;
      const signature = event.operations
        .filter(item => item.state !== 'running')
        .map(item => `${item.operationId}:${item.state}`)
        .sort()
        .join('|');
      if (signature === latest.current) return;
      latest.current = signature;
      void readRef.current();
    }
  });
  const start = async () => {
    if (
      !owns() ||
      busy.current ||
      !key ||
      request.current ||
      !row.profile ||
      !/^\d+$/u.test(count) ||
      Number(count) < 1 ||
      Number(count) > row.productCount
    )
      return;
    const id = crypto.randomUUID();
    try {
      localStorage.setItem(key, id);
    } catch {
      setError(t('catalogPublicationStorageError'));
      return;
    }
    request.current = id;
    const token = ++serial.current;
    busy.current = token;
    setPending(true);
    setUnknown(id);
    setError('');
    flow.current = beginCatalogUiFlow('video_create', { parentFlowId: id, count: Number(count) });
    flow.current.stage('command_requested');
    try {
      const result = await withCatalogCommandDeadline(
        signal =>
          teamApi.startCatalogUpdaterVariants(
            {
              teamId,
              catalogMaterialId: row.catalogId,
              sourceMaterialId: row.videoId,
              requestId: id,
              requestedCount: Number(count),
              profileVersion: row.profile!.version,
              expectedExecutorId: recoveryInstallation() ?? undefined
            },
            { signal }
          ),
        new AbortController().signal
      );
      if (!owns()) return;
      flow.current.stage('command_accepted');
      apply(result);
    } catch (cause) {
      if (owns()) {
        const code = teamErrorCodeOf(cause);
        if (
          (request.current === id &&
            (isCatalogForegroundAdmissionRefused(cause) ||
              isCatalogForegroundPreparationFailure(cause))) ||
          (code &&
            [
              'INVALID_INPUT',
              'PERMISSION_DENIED',
              'WRONG_STATE',
              'REQUEST_REUSE_CONFLICT',
              'SOURCE_CHANGED',
              'RESTITCH_INVALID',
              'AGENT_UPDATE_REQUIRED'
            ].includes(code))
        ) {
          localStorage.removeItem(key);
          request.current = null;
          setUnknown(null);
          flow.current?.fail(code ?? 'PROCESS_RESULT_UNCERTAIN');
        } else flow.current?.stage('stale', 'PROCESS_RESULT_UNCERTAIN');
        setError(
          isCatalogForegroundAdmissionRefused(cause)
            ? t('launchesCatalogExecutorRequired')
            : teamErrorMessageFor(cause, t)
        );
      }
    } finally {
      if (busy.current === token) {
        busy.current = null;
        if (owns()) {
          setPending(false);
          if (readDirty.current) {
            readDirty.current = false;
            queueMicrotask(() => void readRef.current());
          }
        }
      }
    }
  };
  const resume = async () => {
    const id = request.current;
    if (!owns() || busy.current || !id) return;
    const token = ++serial.current;
    busy.current = token;
    setPending(true);
    try {
      const result = await withCatalogCommandDeadline(
        signal => teamApi.resumeCatalogUpdaterVariants(teamId, row.catalogId, id, { signal }),
        new AbortController().signal
      );
      if (owns()) apply(result);
    } catch (cause) {
      if (owns()) {
        setUnknown(id);
        setError(teamErrorMessageFor(cause, t));
      }
    } finally {
      if (busy.current === token) {
        busy.current = null;
        if (owns()) {
          setPending(false);
          if (readDirty.current) {
            readDirty.current = false;
            queueMicrotask(() => void readRef.current());
          }
        }
      }
    }
  };
  const cancel = async () => {
    const id = request.current ?? snapshot?.requestId;
    if (!owns() || busy.current || !id) return;
    const token = ++serial.current;
    busy.current = token;
    setPending(true);
    flow.current?.stage('command_cancel_requested');
    try {
      const result = await withCatalogCommandDeadline(
        signal => teamApi.cancelCatalogUpdaterVariants(teamId, row.catalogId, id, { signal }),
        new AbortController().signal
      );
      if (owns()) apply(result);
    } catch (cause) {
      if (owns()) {
        setUnknown(id);
        setError(teamErrorMessageFor(cause, t));
      }
    } finally {
      if (busy.current === token) {
        busy.current = null;
        if (owns()) {
          setPending(false);
          if (readDirty.current) {
            readDirty.current = false;
            queueMicrotask(() => void readRef.current());
          }
        }
      }
    }
  };
  useEffect(() => {
    if (snapshot?.state === 'canceled') flow.current?.cancel();
    else if (snapshot) flow.current?.stage('result_visible');
  }, [snapshot]);
  const active = Boolean(request.current) || pending;
  const invalid =
    count !== '' &&
    (!/^\d+$/u.test(count) || Number(count) < 1 || Number(count) > row.productCount);
  return (
    <Modal labelledBy={title} onClose={onClose}>
      <h2 id={title}>{t('catalogVideoVariationCount')}</h2>
      <FormField
        htmlFor={countId}
        label={t('catalogVideoVariationCount')}
        error={invalid ? t('catalogVideoVariationLimit', { count: row.productCount }) : undefined}
      >
        <Input
          id={countId}
          inputMode="numeric"
          width="narrow"
          value={count}
          disabled={active}
          aria-invalid={invalid}
          onChange={event => setCount(event.target.value.replace(/[^\d]/gu, '').slice(0, 3))}
        />
      </FormField>
      {snapshot && (
        <p role="status">
          {t(
            snapshot.state === 'ready'
              ? 'catalogVideoVariationsReady'
              : snapshot.state === 'canceled'
                ? 'catalogVideoCreationCanceled'
                : snapshot.state === 'cancel_requested'
                  ? 'catalogVideoCreationCanceling'
                  : 'catalogVideoCreationProgress',
            { ready: snapshot.registeredCount, total: snapshot.requestedCount }
          )}
        </p>
      )}
      {snapshot?.publicationBlockedReason === 'writer_unsupported' && (
        <p role="status" className="team-inline-note">
          {t('catalogWriteUnsupported')}
        </p>
      )}
      {snapshot?.publicationBlockedReason === 'legacy_adoption_required' && (
        <p role="status" className="team-inline-note">
          {t('catalogPublicationLegacyHold')}
        </p>
      )}
      {snapshot?.failureCode && (
        <p role="alert" className="team-inline-error">
          {teamErrorMessageFor({ code: snapshot.failureCode }, t)}
        </p>
      )}
      {unknown && <p role="status">{t('catalogVideoCreationUnknown')}</p>}
      {error && (
        <p role="alert" className="team-inline-error">
          {error}
        </p>
      )}
      <div className="team-dialog-actions">
        <Button onClick={() => void read()} disabled={pending}>
          {t('catalogPublicationCheck')}
        </Button>
        {request.current &&
          (unknown ||
            snapshot?.state === 'accepted' ||
            snapshot?.state === 'unknown' ||
            Boolean(snapshot?.failureCode)) && (
            <Button onClick={() => void resume()} disabled={pending}>
              {t('catalogVideoResume')}
            </Button>
          )}
        {request.current && snapshot?.state !== 'cancel_requested' && (
          <Button onClick={() => void cancel()} disabled={pending}>
            {t('catalogVideoCancel')}
          </Button>
        )}
        <Button
          onClick={() => void start()}
          disabled={active || invalid || count === '' || !row.profile}
        >
          {t('catalogVideoCreateVariations')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('productCatalogDone')}
        </Button>
      </div>
    </Modal>
  );
}
