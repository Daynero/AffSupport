import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  LocalItemState,
  LocalOperationStage,
  LocalOperationState
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useI18n, type TranslationKey } from '../../i18n';
import { useOptionalToasts } from '../../components/toast';
import { uploadTeamFile, type TeamFileUploadInput } from '../catalog/material-actions-client';
import type { LocalManifest } from './localManifest';
import { localStageProgress } from './localProgress';
import { WorkspaceOperationJournal, type JournalGroup } from './workspaceOperationJournal';

export interface WorkspaceDestination {
  driveFolderId: string | null;
  materialId: string | null;
}
export interface WorkspaceOperationItem {
  clientItemKey: string;
  relativePath: string;
  idempotencyKey: string;
  state: LocalItemState;
  errorCode: string | null;
  operationId?: string | null;
  resultMaterialId?: string | null;
  resultFolderId?: string | null;
}
export interface WorkspaceOperationGroup {
  id: string;
  teamId: string;
  destination: WorkspaceDestination;
  state: LocalOperationState;
  stage: LocalOperationStage;
  attempt?: number;
  confirmedBytes?: number;
  totalBytes?: number;
  progress?: number | 'indeterminate';
  items: WorkspaceOperationItem[];
}
export interface WorkspaceOperationsClient {
  ensureFolder: (
    teamId: string,
    input: { name: string; parentMaterialId: string | null; idempotencyKey: string }
  ) => Promise<{ folderId: string; materialId: string }>;
  uploadFile: (input: TeamFileUploadInput) => Promise<unknown>;
  getOperation?: typeof teamApi.getOperation;
}
export interface WorkspaceUploadRequest {
  teamId: string;
  destination: WorkspaceDestination;
  manifest: LocalManifest;
  onConflict?: (input: {
    name: string;
    parentKey: string | null;
    existingMaterialId: string;
  }) => Promise<'skip' | 'keep_both' | 'replace'>;
  existingByName?: ReadonlyMap<string, string>;
  /** Must establish the catalog postcondition before the group can succeed. */
  confirmCatalog: () => Promise<void>;
}
export interface WorkspaceOperationsValue {
  groups: WorkspaceOperationGroup[];
  startUploadGroup: (request: WorkspaceUploadRequest) => Promise<WorkspaceOperationGroup>;
  retryUploadGroup: (
    id: string,
    request: WorkspaceUploadRequest
  ) => Promise<WorkspaceOperationGroup>;
  cancelGroup: (id: string) => boolean;
}

const WorkspaceOperationsContext = createContext<WorkspaceOperationsValue | null>(null);
const defaultClient: WorkspaceOperationsClient = {
  ensureFolder: (teamId, input) => teamApi.ensureUploadFolder(teamId, input),
  uploadFile: uploadTeamFile,
  getOperation: (teamId, operationId) => teamApi.getOperation(teamId, operationId)
};

function fromJournal(group: JournalGroup): WorkspaceOperationGroup {
  return {
    id: group.id,
    teamId: group.teamId,
    destination: { ...group.destination },
    state: group.state,
    stage: group.stage,
    attempt: group.attempt,
    confirmedBytes: 0,
    totalBytes: group.items
      .filter(item => item.kind === 'file' && item.state !== 'succeeded')
      .reduce((total, item) => total + item.sizeBytes, 0),
    progress: 'indeterminate',
    items: group.items.map(item => ({
      clientItemKey: item.clientItemKey,
      relativePath: item.relativePath,
      idempotencyKey: item.idempotencyKey,
      state: item.state,
      errorCode: item.errorCode,
      operationId: item.operationId,
      resultMaterialId: item.resultMaterialId,
      resultFolderId: item.resultFolderId
    }))
  };
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async use<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

function errorCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string')
    return cause.code;
  return 'DRIVE_UNAVAILABLE';
}

function terminalState(group: WorkspaceOperationGroup, issueCount: number): LocalOperationState {
  const succeeded = group.items.filter(item => item.state === 'succeeded').length;
  const failed = group.items.some(item => item.state === 'failed' || item.state === 'skipped');
  if (!failed && issueCount === 0) return 'succeeded';
  return succeeded > 0 ? 'partial' : 'failed';
}

const STAGE_LABEL: Record<LocalOperationStage, TranslationKey> = {
  preparing: 'teamWorkspaceStagePreparing',
  creating_folders: 'teamWorkspaceStageFolders',
  transferring: 'teamWorkspaceStageTransfer',
  moving: 'teamWorkspaceStageMoving',
  updating_catalog: 'teamWorkspaceStageCatalog',
  done: 'teamOperationSucceeded'
};

/** One space-level owner for browser transfer groups and their local metadata. */
export function WorkspaceOperationsProvider({
  teamId,
  client = defaultClient,
  actorId,
  journal: suppliedJournal,
  children
}: {
  teamId: string;
  client?: WorkspaceOperationsClient;
  actorId?: string;
  journal?: WorkspaceOperationJournal;
  children: ReactNode;
}) {
  const [groups, setGroups] = useState<WorkspaceOperationGroup[]>([]);
  const { t } = useI18n();
  const toastHost = useOptionalToasts();
  const toastPush = toastHost?.push;
  const toastUpdate = toastHost?.update;
  const toastDismiss = toastHost?.dismiss;
  const toastIds = useRef(new Map<string, number>());
  const ownedGroups = useRef(new Set<string>());
  const activeControllers = useRef(new Map<string, AbortController>());
  const leaseTimers = useRef(new Map<string, number>());
  const journal = useMemo(
    () => suppliedJournal ?? (actorId ? new WorkspaceOperationJournal({ actorId }) : null),
    [actorId, suppliedJournal]
  );
  const globalSlots = useRef(new Semaphore(6));
  useEffect(() => {
    const controllers = activeControllers.current;
    const timers = leaseTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearInterval(timer);
      timers.clear();
      for (const controller of controllers.values())
        controller.abort(Object.assign(new Error('CANCELED'), { code: 'CANCELED' }));
      controllers.clear();
    };
  }, [teamId]);
  const activeTeam = useRef(teamId);
  activeTeam.current = teamId;
  useEffect(() => setGroups([]), [teamId]);
  const publish = useCallback((group: WorkspaceOperationGroup) => {
    if (group.teamId !== activeTeam.current) return;
    setGroups(current => [group, ...current.filter(item => item.id !== group.id)]);
  }, []);

  useEffect(() => {
    if (!toastPush || !toastUpdate || !toastDismiss) return;
    const visible = groups.filter(group =>
      ownedGroups.current.has(group.id) && group.stage !== 'done'
    ).slice(0, 3);
    const visibleIds = new Set(visible.map(group => group.id));
    for (const [id, toastId] of toastIds.current) {
      if (visibleIds.has(id)) continue;
      toastDismiss(toastId);
      toastIds.current.delete(id);
    }
    for (const group of visible) {
      const confirmed = group.items.filter(item => item.state === 'succeeded').length;
      const input = {
        tone: 'info' as const,
        sticky: true,
        text: t('teamOperationRunning'),
        stageLabel: t(STAGE_LABEL[group.stage]),
        detail: t('teamWorkspaceItemsProgress', { done: confirmed, total: group.items.length }),
        progress: group.progress ?? 'indeterminate'
      };
      const existing = toastIds.current.get(group.id);
      if (existing === undefined) toastIds.current.set(group.id, toastPush(input));
      else toastUpdate(existing, input);
    }
  }, [groups, t, toastDismiss, toastPush, toastUpdate]);

  useEffect(() => {
    if (!journal) return;
    let alive = true;
    void (async () => {
      await journal.sweep();
      const saved = await journal.load(teamId);
      for (const group of saved) {
        if (!alive) return;
        if (group.items.some(item => item.operationId) && client.getOperation) {
          try {
            const checked = await journal.reconcile(group.id, async operationIds => {
              const snapshots = await Promise.all(
                operationIds.map(id => client.getOperation!(teamId, id))
              );
              return new Map(
                snapshots.map(snapshot => [
                  snapshot.id,
                  {
                    state:
                      snapshot.state === 'succeeded' ||
                      snapshot.state === 'failed' ||
                      snapshot.state === 'canceled'
                        ? snapshot.state
                        : ('running' as const),
                    resultMaterialId: snapshot.resultMaterialId ?? undefined
                  }
                ])
              );
            });
            group.items = checked.items.map(item => ({
              ...item,
              state:
                item.state === 'running' || item.state === 'pending' ? 'input_required' : item.state
            }));
          } catch {
            // Keep the local checkpoint visible; retry requires a later successful probe.
          }
        }
        setGroups(current =>
          current.some(active => active.id === group.id)
            ? current
            : [fromJournal(group), ...current]
        );
      }
    })().catch(() => {
      // IndexedDB can be unavailable; new work remains usable in this session.
    });
    return () => {
      alive = false;
    };
  }, [client, journal, teamId]);

  const executeUploadGroup = useCallback(
    async (request: WorkspaceUploadRequest, retryId?: string) => {
      if (request.teamId !== teamId) throw new Error('WRONG_TEAM');
      const id = retryId ?? crypto.randomUUID();
      let accepted: JournalGroup | null = null;
      if (retryId) {
        if (!journal) throw new Error('JOURNAL_NOT_FOUND');
        if (activeControllers.current.has(retryId)) throw new Error('LOCAL_OPERATION_OWNED');
        const prior = (await journal.load(teamId)).find(group => group.id === retryId);
        if (!prior) throw new Error('JOURNAL_NOT_FOUND');
        if (
          prior.destination.driveFolderId !== request.destination.driveFolderId ||
          prior.destination.materialId !== request.destination.materialId
        )
          throw new Error('RESELECTION_MISMATCH');
        const entries = request.manifest.entries;
        if (
          entries.length !== prior.items.length ||
          entries.some(entry => {
            const item = prior.items.find(
              candidate => candidate.clientItemKey === entry.clientItemKey
            );
            return (
              !item ||
              item.relativePath !== entry.relativePath ||
              item.kind !== entry.kind ||
              (entry.kind === 'file' && item.sizeBytes !== entry.sizeBytes)
            );
          })
        )
          throw new Error('RESELECTION_MISMATCH');
        if (!(await journal.claim(id))) throw new Error('LOCAL_OPERATION_OWNED');
        if (prior.items.some(item => item.operationId)) {
          if (!client.getOperation) throw new Error('RECONCILE_REQUIRED');
          await journal.reconcile(id, async operationIds => {
            const snapshots = await Promise.all(
              operationIds.map(operationId => client.getOperation!(teamId, operationId))
            );
            return new Map(
              snapshots.map(snapshot => [
                snapshot.id,
                {
                  state:
                    snapshot.state === 'succeeded' ||
                    snapshot.state === 'failed' ||
                    snapshot.state === 'canceled'
                      ? snapshot.state
                      : ('running' as const),
                  resultMaterialId: snapshot.resultMaterialId ?? undefined
                }
              ])
            );
          });
        }
        accepted = await journal.beginRetry(id, { confirmed: true });
      } else if (journal) {
        accepted = await journal.accept({
          id,
          teamId,
          destination: request.destination,
          manifest: request.manifest
        });
      }
      if (accepted && !(await journal!.claim(id))) throw new Error('LOCAL_OPERATION_OWNED');
      ownedGroups.current.add(id);
      const controller = new AbortController();
      activeControllers.current.set(id, controller);
      if (journal) {
        const timer = window.setInterval(() => {
          void journal
            .claim(id)
            .then(owned => {
              if (!owned)
                controller.abort(
                  Object.assign(new Error('LOCAL_OPERATION_OWNED'), {
                    code: 'LOCAL_OPERATION_OWNED'
                  })
                );
            })
            .catch(() => controller.abort(new Error('LOCAL_OPERATION_OWNED')));
        }, 10_000);
        leaseTimers.current.set(id, timer);
      }
      const releaseLocalOwnership = () => {
        activeControllers.current.delete(id);
        const timer = leaseTimers.current.get(id);
        if (timer !== undefined) window.clearInterval(timer);
        leaseTimers.current.delete(id);
      };
      const group: WorkspaceOperationGroup = accepted
        ? fromJournal(accepted)
        : {
            id,
            teamId,
            destination: { ...request.destination },
            state: 'preparing',
            stage: 'preparing',
            items: request.manifest.entries.map(entry => ({
              clientItemKey: entry.clientItemKey,
              relativePath: entry.relativePath,
              idempotencyKey: crypto.randomUUID(),
              state: 'pending',
              errorCode: null
            }))
          };
      const fileSizes = new Map(
        request.manifest.entries
          .filter(entry => entry.kind === 'file')
          .map(entry => [entry.clientItemKey, entry.sizeBytes])
      );
      const confirmedOffsets = new Map<string, number>();
      group.confirmedBytes = 0;
      group.totalBytes = request.manifest.entries.reduce(
        (total, entry) =>
          entry.kind === 'file' &&
          group.items.find(item => item.clientItemKey === entry.clientItemKey)?.state !==
            'succeeded'
            ? total + entry.sizeBytes
            : total,
        0
      );
      const update = () => {
        const directoryItems = request.manifest.entries.filter(entry => entry.kind === 'directory');
        group.progress = localStageProgress({
          stage: group.stage,
          confirmedBytes: group.confirmedBytes ?? 0,
          totalBytes: group.totalBytes ?? 0,
          completedItems:
            group.stage === 'creating_folders'
              ? directoryItems.filter(entry =>
                  group.items.some(
                    item =>
                      item.clientItemKey === entry.clientItemKey &&
                      ['succeeded', 'failed', 'skipped', 'canceled'].includes(item.state)
                  )
                ).length
              : group.items.filter(item =>
                  ['succeeded', 'failed', 'skipped', 'canceled'].includes(item.state)
                ).length,
          totalItems:
            group.stage === 'creating_folders' ? directoryItems.length : group.items.length,
          succeeded: group.state === 'succeeded'
        });
        publish({ ...group, items: group.items.map(item => ({ ...item })) });
      };
      let checkpoint = Promise.resolve();
      const saveItem = (
        key: string,
        patch: Parameters<WorkspaceOperationJournal['checkpointItem']>[2]
      ) => {
        if (!journal) return checkpoint;
        checkpoint = checkpoint.then(async () => {
          await journal.checkpointItem(group.id, key, patch);
        });
        return checkpoint;
      };
      const saveGroup = () => {
        if (!journal) return checkpoint;
        checkpoint = checkpoint.then(async () => {
          await journal.checkpointGroup(group.id, { state: group.state, stage: group.stage });
        });
        return checkpoint;
      };
      const mark = async (key: string, state: LocalItemState, code: string | null = null) => {
        const item = group.items.find(candidate => candidate.clientItemKey === key);
        if (item) {
          item.state = state;
          item.errorCode = code;
          update();
          await saveItem(key, { state, errorCode: code });
        }
      };
      update();
      const fatal = request.manifest.issues.some(issue =>
        ['INVALID_PATH', 'LIMIT_EXCEEDED', 'CYCLE', 'DUPLICATE'].includes(issue.code)
      );
      if (fatal) {
        group.state = 'failed';
        group.stage = 'done';
        for (const item of group.items) {
          item.state = 'skipped';
          item.errorCode = 'INVALID_INPUT';
          await saveItem(item.clientItemKey, { state: 'skipped', errorCode: 'INVALID_INPUT' });
        }
        update();
        await saveGroup();
        releaseLocalOwnership();
        return group;
      }

      group.state = 'running';
      group.stage = 'creating_folders';
      update();
      await saveGroup();
      const resolved = new Map<string, WorkspaceDestination>();
      for (const item of accepted?.items ?? []) {
        if (
          item.kind === 'directory' &&
          item.state === 'succeeded' &&
          item.resultFolderId &&
          item.resultMaterialId
        ) {
          resolved.set(item.clientItemKey, {
            driveFolderId: item.resultFolderId,
            materialId: item.resultMaterialId
          });
        }
      }
      const parentOf = (key: string | null): WorkspaceDestination | null =>
        key === null ? request.destination : (resolved.get(key) ?? null);
      for (const entry of request.manifest.entries) {
        if (entry.kind !== 'directory') continue;
        if (resolved.has(entry.clientItemKey)) continue;
        if (controller.signal.aborted) {
          await mark(entry.clientItemKey, 'canceled');
          continue;
        }
        const parent = parentOf(entry.parentKey);
        if (!parent) {
          await mark(entry.clientItemKey, 'skipped', 'PARENT_FAILED');
          continue;
        }
        await mark(entry.clientItemKey, 'running');
        try {
          const name = entry.relativePath.split('/').at(-1)!;
          const created = await globalSlots.current.use(() =>
            client.ensureFolder(teamId, {
              name,
              parentMaterialId: parent.materialId,
              idempotencyKey: group.items.find(item => item.clientItemKey === entry.clientItemKey)!
                .idempotencyKey
            })
          );
          resolved.set(entry.clientItemKey, {
            driveFolderId: created.folderId,
            materialId: created.materialId
          });
          const item = group.items.find(
            candidate => candidate.clientItemKey === entry.clientItemKey
          )!;
          item.resultMaterialId = created.materialId;
          item.resultFolderId = created.folderId;
          await saveItem(entry.clientItemKey, {
            state: 'succeeded',
            resultMaterialId: created.materialId,
            resultFolderId: created.folderId
          });
          await mark(entry.clientItemKey, 'succeeded');
        } catch (cause) {
          await mark(entry.clientItemKey, 'failed', errorCode(cause));
        }
      }

      group.stage = 'transferring';
      update();
      await saveGroup();
      const files = request.manifest.entries.filter(entry => entry.kind === 'file');
      let next = 0;
      const transfer = async (entry: (typeof files)[number]) => {
        if (
          group.items.find(item => item.clientItemKey === entry.clientItemKey)?.state ===
          'succeeded'
        )
          return;
        if (controller.signal.aborted) {
          await mark(entry.clientItemKey, 'canceled');
          return;
        }
        const parent = parentOf(entry.parentKey);
        if (!parent) {
          await mark(entry.clientItemKey, 'skipped', 'PARENT_FAILED');
          return;
        }
        const name = entry.relativePath.split('/').at(-1)!;
        const existingMaterialId =
          entry.parentKey === null
            ? request.existingByName?.get(name.toLocaleLowerCase())
            : undefined;
        let choice: 'skip' | 'keep_both' | 'replace' = 'keep_both';
        if (existingMaterialId) {
          if (!request.onConflict) {
            await mark(entry.clientItemKey, 'failed', 'CONFLICT_NEEDS_DECISION');
            return;
          }
          try {
            choice = await request.onConflict({
              name,
              parentKey: entry.parentKey,
              existingMaterialId
            });
            if (controller.signal.aborted) {
              await mark(entry.clientItemKey, 'canceled');
              return;
            }
          } catch (cause) {
            await mark(entry.clientItemKey, 'failed', errorCode(cause));
            return;
          }
        }
        if (choice === 'skip') {
          await mark(entry.clientItemKey, 'skipped');
          return;
        }
        await mark(entry.clientItemKey, 'running');
        try {
          const item = group.items.find(
            candidate => candidate.clientItemKey === entry.clientItemKey
          )!;
          const result = await globalSlots.current.use(() =>
            client.uploadFile({
              teamId,
              destinationFolderId: parent.driveFolderId,
              file: entry.source,
              conflictMode: 'keep_both',
              replaceMaterialId: null,
              versionOfMaterialId: choice === 'replace' ? (existingMaterialId ?? null) : null,
              signal: controller.signal,
              onProgress: confirmedBytes => {
                const size = fileSizes.get(entry.clientItemKey) ?? 0;
                const previous = confirmedOffsets.get(entry.clientItemKey) ?? 0;
                const next = Math.min(size, Math.max(previous, confirmedBytes));
                if (next === previous) return;
                confirmedOffsets.set(entry.clientItemKey, next);
                group.confirmedBytes = [...confirmedOffsets.values()].reduce(
                  (sum, offset) => sum + offset,
                  0
                );
                update();
              },
              idempotencyKey: item.idempotencyKey,
              onOperationAccepted: async operationId => {
                item.operationId = operationId;
                await saveItem(entry.clientItemKey, { state: 'running', operationId });
              }
            })
          );
          if (
            result &&
            typeof result === 'object' &&
            'state' in result &&
            result.state !== 'succeeded'
          )
            throw Object.assign(new Error('UPLOAD_NOT_COMPLETE'), { code: 'UPLOAD_NOT_COMPLETE' });
          if (
            result &&
            typeof result === 'object' &&
            'materialId' in result &&
            typeof result.materialId === 'string'
          ) {
            item.resultMaterialId = result.materialId;
            await saveItem(entry.clientItemKey, {
              state: 'succeeded',
              resultMaterialId: result.materialId
            });
          }
          await mark(entry.clientItemKey, 'succeeded');
        } catch (cause) {
          await mark(
            entry.clientItemKey,
            controller.signal.aborted ? 'canceled' : 'failed',
            controller.signal.aborted ? null : errorCode(cause)
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, files.length) }, async () => {
          for (let index = next++; index < files.length; index = next++)
            await transfer(files[index]!);
        })
      );
      group.stage = 'updating_catalog';
      update();
      await saveGroup();
      try {
        await request.confirmCatalog();
        group.state = controller.signal.aborted
          ? 'canceled'
          : terminalState(group, request.manifest.issues.length);
      } catch {
        group.state = controller.signal.aborted
          ? 'canceled'
          : group.items.some(item => item.state === 'succeeded')
            ? 'partial'
            : 'failed';
      }
      group.stage = 'done';
      update();
      await saveGroup();
      releaseLocalOwnership();
      return group;
    },
    [client, journal, publish, teamId]
  );

  const startUploadGroup = useCallback(
    (request: WorkspaceUploadRequest) => executeUploadGroup(request),
    [executeUploadGroup]
  );
  const retryUploadGroup = useCallback(
    (id: string, request: WorkspaceUploadRequest) => executeUploadGroup(request, id),
    [executeUploadGroup]
  );
  const cancelGroup = useCallback((id: string) => {
    const controller = activeControllers.current.get(id);
    if (!controller) return false;
    controller.abort(Object.assign(new Error('CANCELED'), { code: 'CANCELED' }));
    return true;
  }, []);

  const value = useMemo<WorkspaceOperationsValue>(
    () => ({ groups, startUploadGroup, retryUploadGroup, cancelGroup }),
    [groups, startUploadGroup, retryUploadGroup, cancelGroup]
  );
  return (
    <WorkspaceOperationsContext.Provider value={value}>
      {children}
    </WorkspaceOperationsContext.Provider>
  );
}

export function WorkspaceOperationsContextOverride({
  value,
  children
}: {
  value: WorkspaceOperationsValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceOperationsContext.Provider value={value}>
      {children}
    </WorkspaceOperationsContext.Provider>
  );
}

export function useWorkspaceOperations(): WorkspaceOperationsValue {
  const context = useContext(WorkspaceOperationsContext);
  if (!context) throw new Error('WorkspaceOperationsProvider missing');
  return context;
}

export function useOptionalWorkspaceOperations(): WorkspaceOperationsValue | null {
  return useContext(WorkspaceOperationsContext);
}
