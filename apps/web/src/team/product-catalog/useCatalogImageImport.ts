import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CATALOG_IMAGE_LIMITS,
  type CatalogImageCapabilities,
  type CatalogImageImportEntry,
  type CatalogImageGrant,
  type CatalogImageImportJob,
  type CatalogImageImportList,
  type CatalogImageInventory,
  type CatalogImageDictionaryPage,
  type CatalogImageDictionaryEntry
} from '@video-compressor/shared';
import { TeamApiError } from '../../api/team';
import { uploadCatalogImage, type CatalogImageClient } from '../../api/team-catalog-images';
import { useTeam } from '../TeamContext';
import { useCatalogRead } from '../catalog/CatalogFreshness';
import { analytics } from '../../analytics/service';

function imageInputSignal(
  event:
    | 'operation_started'
    | 'operation_stage_completed'
    | 'operation_completed'
    | 'operation_failed'
    | 'operation_cancelled',
  flowId: string,
  stage: string,
  source: 'local' | 'drive',
  jobId?: string,
  code?: string
) {
  try {
    analytics.track(event, {
      flow_id: flowId,
      feature_identifier: 'catalog_images',
      flow_step: 'catalog_image_import',
      action_identifier: stage,
      source_kind: source,
      ...(jobId ? { run_id: jobId } : {}),
      ...(code ? { error_code: code } : {})
    });
  } catch {
    /* Diagnostics never change input delivery. */
  }
}
type ImagePoolAction = 'remove' | 'revoke';
function imagePoolSignal(
  stage: 'requested' | 'accepted' | 'failed' | 'result_visible',
  flowId: string,
  publicationId: string,
  action: ImagePoolAction,
  code?: string
) {
  try {
    analytics.track(
      stage === 'requested'
        ? 'operation_started'
        : stage === 'accepted'
          ? 'operation_stage_completed'
          : stage === 'failed'
            ? 'operation_failed'
            : 'operation_completed',
      {
        flow_id: flowId,
        run_id: publicationId,
        feature_identifier: 'catalog_images',
        flow_step: 'catalog_image_pool',
        action_identifier: `${action}_${stage}`,
        ...(code ? { error_code: code } : {})
      }
    );
  } catch {
    /* Diagnostics never change pool mutation behavior. */
  }
}

export interface QueuedCatalogImage {
  key: string;
  file: File;
}
const terminal = (job: CatalogImageImportJob) =>
  ['completed', 'partial', 'failed', 'cancelled', 'expired'].includes(job.state);

function waitForImageCapacity(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 5000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Retry only refused capacity admission. The same grant intent is retained throughout. */
export async function requestCatalogImageGrant(
  client: CatalogImageClient,
  jobId: string,
  entry: CatalogImageImportEntry,
  requestKey: string,
  signal: AbortSignal,
  onWaiting: (waiting: boolean) => void
): Promise<CatalogImageGrant> {
  let waiting = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await client.grant(jobId, entry.id, {
          generation: entry.grantGeneration ?? 0,
          requestKey
        });
      } catch (cause) {
        if (
          !(cause instanceof TeamApiError) ||
          cause.code !== 'IMAGE_UPLOAD_CAPACITY_BUSY' ||
          attempt >= 48
        )
          throw cause;
        if (!waiting) {
          waiting = true;
          onWaiting(true);
        }
        await waitForImageCapacity(signal);
      }
    }
  } finally {
    if (waiting) onWaiting(false);
  }
}

export function useCatalogImageImport(teamId: string, client: CatalogImageClient) {
  const { revision } = useTeam();
  const beginRead = useCatalogRead(teamId);
  const [capabilities, setCapabilities] = useState<CatalogImageCapabilities | null>(null);
  const [inventory, setInventory] = useState<CatalogImageInventory | null>(null);
  const [dictionary, setDictionary] = useState<CatalogImageDictionaryPage | null>(null);
  const [pendingPoolResult, setPendingPoolResult] = useState<{
    teamId: string;
    flowId: string;
    publicationId: string;
    entryId: string;
    revision: number;
    action: ImagePoolAction;
  } | null>(null);
  const visiblePoolFlow = useRef<string | null>(null);
  const [revocationRequested, setRevocationRequested] = useState(false);
  const [imports, setImports] = useState<CatalogImageImportList | null>(null);
  const [job, setJob] = useState<CatalogImageImportJob | null>(null);
  const [files, setFiles] = useState<QueuedCatalogImage[]>([]);
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [waitingUploads, setWaitingUploads] = useState(0);
  const active = useRef(0);
  const read = useRef({ pending: false, dirty: false });
  const selected = useRef<string | null>(null);
  const intent = useRef(crypto.randomUUID());
  const transfer = useRef<AbortController | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const observedFlows = useRef(new Map<string, string>());
  const actionKey = (key: string) => {
    const existing = actionKeys.current.get(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    actionKeys.current.set(key, fresh);
    return fresh;
  };
  const acceptJob = useCallback(
    (next: CatalogImageImportJob) => {
      if (next.teamId !== teamId) throw new TeamApiError('INVALID_RESPONSE', false);
      selected.current = next.id;
      setJob(previous =>
        previous?.id === next.id && previous.revision > next.revision ? previous : next
      );
    },
    [teamId]
  );

  const refresh = useCallback(async () => {
    if (read.current.pending) {
      read.current.dirty = true;
      return;
    }
    const generation = active.current;
    const stamp = beginRead();
    read.current.pending = true;
    try {
      const caps = await client.capabilities(teamId);
      if (generation !== active.current) return;
      setCapabilities(caps);
      // Recovery reads remain available when admission is off, including jobs
      // that stopped before the team's first ready R2 publication.
      const [found, summary, page] = await Promise.all([
        client.listImports(teamId),
        client.inventory(teamId),
        client.dictionary(teamId)
      ]);
      if (generation !== active.current) return;
      if (found.items.some(item => item.teamId !== teamId))
        throw new TeamApiError('INVALID_RESPONSE', false);
      setImports(found);
      setDictionary(page);
      setInventory(previous =>
        previous && previous.revision > summary.revision ? previous : summary
      );
      const id =
        selected.current ?? found.items.find(item => !terminal(item))?.id ?? found.items[0]?.id;
      if (id) {
        const detail = await client.getImport(id);
        if (generation !== active.current) return;
        acceptJob(detail);
      }
      setReadError(null);
      stamp.succeed();
    } catch (cause) {
      if (generation === active.current) {
        setReadError(cause);
        stamp.fail();
      }
    } finally {
      if (generation === active.current) {
        setLoading(false);
        read.current.pending = false;
        if (read.current.dirty) {
          read.current.dirty = false;
          void refresh();
        }
      }
    }
  }, [acceptJob, beginRead, client, teamId]);

  useEffect(() => {
    active.current += 1;
    read.current = { pending: false, dirty: false };
    selected.current = null;
    intent.current = crypto.randomUUID();
    actionKeys.current.clear();
    observedFlows.current.clear();
    setCapabilities(null);
    setInventory(null);
    setDictionary(null);
    setPendingPoolResult(null);
    visiblePoolFlow.current = null;
    setImports(null);
    setJob(null);
    setRevocationRequested(false);
    setFiles([]);
    setFolder(null);
    setBusy(false);
    setWaitingUploads(0);
    setLoading(true);
    setError(null);
    setReadError(null);
    void refresh();
    return () => {
      active.current += 1;
      transfer.current?.abort();
    };
  }, [teamId, client, refresh]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (
      !pendingPoolResult ||
      pendingPoolResult.teamId !== teamId ||
      !dictionary ||
      dictionary.revision < pendingPoolResult.revision ||
      dictionary.items.some(entry => entry.id === pendingPoolResult.entryId)
    )
      return;
    if (visiblePoolFlow.current !== pendingPoolResult.flowId) {
      visiblePoolFlow.current = pendingPoolResult.flowId;
      imagePoolSignal(
        'result_visible',
        pendingPoolResult.flowId,
        pendingPoolResult.publicationId,
        pendingPoolResult.action
      );
    }
    setPendingPoolResult(null);
  }, [dictionary, pendingPoolResult, teamId]);
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision;
      void refresh();
    }
  }, [revision, refresh]);
  useEffect(() => {
    if (!job || !terminal(job)) return;
    const flow = observedFlows.current.get(job.id);
    if (!flow) return;
    observedFlows.current.delete(job.id);
    imageInputSignal(
      job.state === 'cancelled'
        ? 'operation_cancelled'
        : job.state === 'failed'
          ? 'operation_failed'
          : 'operation_completed',
      flow,
      job.state,
      job.sourceKind,
      job.id
    );
  }, [job]);

  const queueFiles = (incoming: readonly File[]) => {
    if (busy || incoming.length === 0) return;
    const all = [...files, ...incoming.map(file => ({ key: crypto.randomUUID(), file }))];
    if (
      all.length > CATALOG_IMAGE_LIMITS.maxFiles ||
      all.reduce((sum, item) => sum + item.file.size, 0) > CATALOG_IMAGE_LIMITS.maxJobBytes
    ) {
      setError(new TeamApiError('IMAGE_QUOTA_EXCEEDED', false));
      return;
    }
    if (incoming.some(file => file.size === 0 || file.size > CATALOG_IMAGE_LIMITS.maxBytes)) {
      setError(new TeamApiError('IMAGE_TOO_LARGE', false));
      return;
    }
    if (incoming.some(file => !/\.(?:png|jpe?g|webp)$/iu.test(file.name))) {
      setError(new TeamApiError('IMAGE_UNSUPPORTED_FORMAT', false));
      return;
    }
    setFolder(null);
    setFiles(all);
    setError(null);
    intent.current = crypto.randomUUID();
  };
  const removeFile = (key: string) => {
    if (busy) return;
    setFiles(current => current.filter(item => item.key !== key));
    intent.current = crypto.randomUUID();
  };
  const chooseFolder = (next: { id: string; name: string }) => {
    if (busy) return;
    setFiles([]);
    setFolder(next);
    setError(null);
    intent.current = crypto.randomUUID();
  };

  const allEntries = async (first: CatalogImageImportJob): Promise<CatalogImageImportEntry[]> => {
    const entries = [...first.entries];
    let page = first;
    const cursors = new Set<string>();
    while (page.hasMore) {
      if (
        !page.nextCursor ||
        cursors.has(page.nextCursor) ||
        entries.length >= CATALOG_IMAGE_LIMITS.maxFiles
      )
        throw new TeamApiError('INVALID_RESPONSE', false);
      cursors.add(page.nextCursor);
      page = await client.getImport(first.id, page.nextCursor);
      if (page.id !== first.id || page.teamId !== teamId)
        throw new TeamApiError('INVALID_RESPONSE', false);
      entries.push(...page.entries);
    }
    return entries;
  };

  const start = async (loadDriveSources?: () => Promise<readonly string[]>) => {
    if (
      busy ||
      !capabilities?.enabled ||
      !capabilities.importEnabled ||
      !capabilities.canManage ||
      (!folder && !loadDriveSources && files.length === 0)
    )
      return;
    const generation = active.current;
    const abort = new AbortController();
    transfer.current = abort;
    setBusy(true);
    setError(null);
    setUploadedBytes(0);
    setWaitingUploads(0);
    const flowId = intent.current;
    const sourceKind = folder || loadDriveSources ? 'drive' : 'local';
    imageInputSignal('operation_started', flowId, 'requested', sourceKind);
    let current: CatalogImageImportJob | null = null;
    try {
      const sourceMaterialIds = loadDriveSources
        ? [...new Set(await loadDriveSources())]
        : folder
          ? [folder.id]
          : [];
      if (generation !== active.current || abort.signal.aborted) return;
      if (loadDriveSources && sourceMaterialIds.length === 0)
        throw new TeamApiError('IMAGE_SOURCE_UNAVAILABLE', false);
      if (sourceMaterialIds.length > 100) throw new TeamApiError('IMAGE_QUOTA_EXCEEDED', false);
      // A discovered waiting import can resume after explicit file reselection.
      const resumableJob =
        sourceKind === 'local' &&
        job?.sourceKind === 'local' &&
        !terminal(job) &&
        job.state !== 'collecting'
          ? job
          : null;
      // Read further pages only after explicit reselection/start. A waiting
      // source can sort after the first hundred already-ready entries.
      const resumeEntries = resumableJob ? await allEntries(resumableJob) : [];
      if (generation !== active.current || abort.signal.aborted) return;
      const resume =
        resumableJob &&
        resumeEntries.some(
          entry =>
            entry.state === 'waiting_source' &&
            files.some(
              item => item.file.name === entry.displayName && item.file.size === entry.declaredSize
            )
        );
      current =
        resume && resumableJob
          ? await client.getImport(resumableJob.id)
          : await client.beginImport({
              teamId,
              sourceKind,
              idempotencyKey: intent.current,
              ...(sourceKind === 'drive' ? { sourceMaterialIds } : {})
            });
      if (generation !== active.current || abort.signal.aborted) return;
      acceptJob(current);
      observedFlows.current.set(current.id, flowId);
      imageInputSignal(
        'operation_stage_completed',
        flowId,
        'accepted',
        current.sourceKind,
        current.id
      );
      if (sourceKind === 'drive') {
        setFolder(null);
        intent.current = crypto.randomUUID();
        return;
      }
      const selectedFiles = files;
      if (current.state === 'collecting') {
        for (
          let index = 0;
          index < selectedFiles.length;
          index += CATALOG_IMAGE_LIMITS.manifestPage
        ) {
          const page = selectedFiles.slice(index, index + CATALOG_IMAGE_LIMITS.manifestPage);
          current = await client.appendManifest(current.id, {
            pageKey: `${intent.current}:${index}`,
            entries: page.map(item => ({
              clientFileKey: item.key,
              name: item.file.name,
              declaredSize: item.file.size,
              declaredMime: item.file.type
            }))
          });
          if (generation !== active.current || abort.signal.aborted) return;
          acceptJob(current);
        }
        current = await client.seal(current.id, {
          revision: current.revision,
          manifestCount: selectedFiles.length
        });
      }
      const entries = await allEntries(current);
      const work = entries.filter(entry => entry.state === 'waiting_source');
      const fileFor = new Map<string, File>();
      for (const entry of work) {
        const byKey = selectedFiles.find(item => item.key === entry.clientFileKey);
        const candidates = selectedFiles.filter(
          item => item.file.name === entry.displayName && item.file.size === entry.declaredSize
        );
        const found = byKey?.file ?? (candidates.length === 1 ? candidates[0]?.file : undefined);
        if (!found) throw new TeamApiError('IMAGE_LOCAL_SOURCE_REQUIRED', false);
        fileFor.set(entry.id, found);
      }
      const progress = new Map<string, number>();
      const importId = current.id;
      let next = 0;
      let failure: unknown = null;
      const send = async () => {
        while (!failure && !abort.signal.aborted) {
          const entry = work[next++];
          if (!entry) return;
          try {
            const file = fileFor.get(entry.id);
            if (!file) throw new TeamApiError('IMAGE_LOCAL_SOURCE_REQUIRED', false);
            const grantGeneration = entry.grantGeneration ?? 0;
            const grant = await requestCatalogImageGrant(
              client,
              importId,
              entry,
              actionKey(`grant:${entry.id}:${grantGeneration}`),
              abort.signal,
              waiting => {
                if (generation === active.current)
                  setWaitingUploads(count => Math.max(0, count + (waiting ? 1 : -1)));
              }
            );
            if (generation !== active.current || abort.signal.aborted) return;
            await uploadCatalogImage(grant, file, {
              signal: abort.signal,
              onProgress: bytes => {
                progress.set(entry.id, bytes);
                if (generation === active.current)
                  setUploadedBytes([...progress.values()].reduce((a, b) => a + b, 0));
              }
            });
            if (generation !== active.current || abort.signal.aborted) return;
            const snapshot = await client.delivered(importId, entry.id, {
              grantGeneration: grant.generation,
              requestKey: actionKey(`delivered:${entry.id}:${grant.generation}`)
            });
            if (generation === active.current) acceptJob(snapshot);
          } catch (cause) {
            failure ??= cause;
          }
        }
      };
      await Promise.all(Array.from({ length: CATALOG_IMAGE_LIMITS.uploadConcurrency }, send));
      if (failure) throw failure;
      if (generation === active.current && !abort.signal.aborted) {
        imageInputSignal(
          'operation_stage_completed',
          flowId,
          'input_delivered',
          'local',
          current.id
        );
        setFiles([]);
        intent.current = crypto.randomUUID();
      }
    } catch (cause) {
      if (current) observedFlows.current.delete(current.id);
      if (!abort.signal.aborted)
        imageInputSignal(
          'operation_failed',
          flowId,
          'input_delivery',
          sourceKind,
          current?.id,
          cause instanceof TeamApiError ? cause.code : 'UNKNOWN'
        );
      if (generation === active.current && !abort.signal.aborted) setError(cause);
    } finally {
      if (generation === active.current) {
        setBusy(false);
        transfer.current = null;
        // A lost reply is reconciled by reading; it never causes a blind re-upload.
        await refresh();
      }
    }
  };

  const runJobAction = async (kind: 'cancel' | 'retry') => {
    if (!job || (busy && kind !== 'cancel')) return;
    const generation = active.current;
    try {
      const snapshot =
        kind === 'cancel'
          ? await client.cancel(job.id, {
              revision: job.revision,
              idempotencyKey: actionKey(`cancel:${job.id}:${job.revision}`)
            })
          : await client.retry(job.id, {
              idempotencyKey: actionKey(`retry:${job.id}:${job.revision}`)
            });
      if (generation !== active.current) return;
      if (kind === 'cancel') transfer.current?.abort();
      acceptJob(snapshot);
      await refresh();
    } catch (cause) {
      if (generation === active.current) setError(cause);
    }
  };
  const selectJob = async (id: string) => {
    const generation = active.current;
    try {
      const next = await client.getImport(id);
      if (generation === active.current) acceptJob(next);
    } catch (cause) {
      if (generation === active.current) setError(cause);
    }
  };
  const moreJobs = async () => {
    if (!imports?.nextCursor) return;
    const generation = active.current;
    try {
      const page = await client.listImports(teamId, imports.nextCursor);
      if (generation === active.current)
        setImports(previous =>
          previous
            ? {
                ...page,
                items: [
                  ...previous.items,
                  ...page.items.filter(item => !previous.items.some(old => old.id === item.id))
                ]
              }
            : page
        );
    } catch (cause) {
      if (generation === active.current) setError(cause);
    }
  };
  const moreEntries = async () => {
    if (!job?.nextCursor || job.entries.length >= CATALOG_IMAGE_LIMITS.maxFiles) return;
    const generation = active.current;
    try {
      const page = await client.getImport(job.id, job.nextCursor);
      if (generation !== active.current || page.id !== selected.current) return;
      acceptJob({
        ...page,
        entries: [
          ...job.entries,
          ...page.entries.filter(entry => !job.entries.some(old => old.id === entry.id))
        ]
      });
    } catch (cause) {
      if (generation === active.current) setError(cause);
    }
  };
  const morePictures = async () => {
    if (!dictionary?.nextCursor) return;
    const generation = active.current;
    try {
      const page = await client.dictionary(teamId, dictionary.nextCursor);
      if (generation === active.current) setDictionary(page);
    } catch (cause) {
      if (generation === active.current) setError(cause);
    }
  };
  const continueImport = async () => {
    if (!job || busy || !capabilities?.importEnabled || !capabilities.canManage) return;
    const generation = active.current;
    setBusy(true);
    setError(null);
    try {
      const next = await client.continueImport(job.id, {
        idempotencyKey: actionKey(`continue:${job.id}`)
      });
      if (generation !== active.current) return;
      acceptJob(next);
      await refresh();
    } catch (cause) {
      if (generation === active.current) setError(cause);
    } finally {
      if (generation === active.current) setBusy(false);
    }
  };
  const changePicture = async (entry: CatalogImageDictionaryEntry, kind: 'remove' | 'revoke') => {
    if (busy || !capabilities?.canManage) return;
    const generation = active.current;
    const flowId = crypto.randomUUID();
    imagePoolSignal('requested', flowId, entry.publicationId, kind);
    setBusy(true);
    setError(null);
    try {
      const input = {
        revision: entry.revision,
        idempotencyKey: actionKey(`${kind}:${entry.id}:${entry.revision}`)
      };
      const page =
        kind === 'remove'
          ? await client.remove(entry.id, input)
          : await client.revoke(entry.publicationId, input);
      imagePoolSignal('accepted', flowId, entry.publicationId, kind);
      if (generation !== active.current) return;
      setDictionary(page);
      setPendingPoolResult({
        teamId,
        flowId,
        publicationId: entry.publicationId,
        entryId: entry.id,
        revision: page.revision,
        action: kind
      });
      if (kind === 'revoke') setRevocationRequested(true);
      await refresh();
    } catch (cause) {
      imagePoolSignal(
        'failed',
        flowId,
        entry.publicationId,
        kind,
        cause instanceof TeamApiError ? cause.code : 'UNKNOWN'
      );
      if (generation === active.current) setError(cause);
    } finally {
      if (generation === active.current) setBusy(false);
    }
  };
  return {
    capabilities,
    inventory,
    dictionary,
    revocationRequested,
    imports,
    job,
    files,
    folder,
    busy,
    loading,
    error: error ?? readError,
    uploadedBytes,
    waitingUploads,
    totalBytes: files.reduce((sum, item) => sum + item.file.size, 0),
    queueFiles,
    removeFile,
    chooseFolder,
    start,
    refresh,
    selectJob,
    moreJobs,
    moreEntries,
    morePictures,
    continueImport,
    removePicture: (entry: CatalogImageDictionaryEntry) => changePicture(entry, 'remove'),
    revokePicture: (entry: CatalogImageDictionaryEntry) => changePicture(entry, 'revoke'),
    cancel: () => runJobAction('cancel'),
    retry: () => runJobAction('retry')
  };
}
