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
import { uploadTeamFile, type TeamFileUploadInput } from '../catalog/material-actions-client';
import type { LocalManifest } from './localManifest';

export interface WorkspaceDestination {
  driveFolderId: string | null;
  materialId: string | null;
}
export interface WorkspaceOperationItem {
  clientItemKey: string;
  relativePath: string;
  state: LocalItemState;
  errorCode: string | null;
}
export interface WorkspaceOperationGroup {
  id: string;
  teamId: string;
  destination: WorkspaceDestination;
  state: LocalOperationState;
  stage: LocalOperationStage;
  items: WorkspaceOperationItem[];
}
export interface WorkspaceOperationsClient {
  ensureFolder: (
    teamId: string,
    input: { name: string; parentMaterialId: string | null }
  ) => Promise<{ folderId: string; materialId: string }>;
  uploadFile: (input: TeamFileUploadInput) => Promise<unknown>;
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
}

const WorkspaceOperationsContext = createContext<WorkspaceOperationsValue | null>(null);
const defaultClient: WorkspaceOperationsClient = {
  ensureFolder: (teamId, input) => teamApi.ensureUploadFolder(teamId, input),
  uploadFile: uploadTeamFile
};

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

/** One in-memory owner for browser transfer groups; journaling and toast projection arrive in US5. */
export function WorkspaceOperationsProvider({
  teamId,
  client = defaultClient,
  children
}: {
  teamId: string;
  client?: WorkspaceOperationsClient;
  children: ReactNode;
}) {
  const [groups, setGroups] = useState<WorkspaceOperationGroup[]>([]);
  const globalSlots = useRef(new Semaphore(6));
  const activeTeam = useRef(teamId);
  activeTeam.current = teamId;
  useEffect(() => setGroups([]), [teamId]);
  const publish = useCallback((group: WorkspaceOperationGroup) => {
    if (group.teamId !== activeTeam.current) return;
    setGroups(current => [group, ...current.filter(item => item.id !== group.id)]);
  }, []);

  const startUploadGroup = useCallback(
    async (request: WorkspaceUploadRequest) => {
      if (request.teamId !== teamId) throw new Error('WRONG_TEAM');
      const group: WorkspaceOperationGroup = {
        id: crypto.randomUUID(),
        teamId,
        destination: { ...request.destination },
        state: 'preparing',
        stage: 'preparing',
        items: request.manifest.entries.map(entry => ({
          clientItemKey: entry.clientItemKey,
          relativePath: entry.relativePath,
          state: 'pending',
          errorCode: null
        }))
      };
      const update = () => publish({ ...group, items: group.items.map(item => ({ ...item })) });
      const mark = (key: string, state: LocalItemState, code: string | null = null) => {
        const item = group.items.find(candidate => candidate.clientItemKey === key);
        if (item) {
          item.state = state;
          item.errorCode = code;
          update();
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
        }
        update();
        return group;
      }

      group.state = 'running';
      group.stage = 'creating_folders';
      update();
      const resolved = new Map<string, WorkspaceDestination>();
      const parentOf = (key: string | null): WorkspaceDestination | null =>
        key === null ? request.destination : (resolved.get(key) ?? null);
      for (const entry of request.manifest.entries) {
        if (entry.kind !== 'directory') continue;
        const parent = parentOf(entry.parentKey);
        if (!parent) {
          mark(entry.clientItemKey, 'skipped', 'PARENT_FAILED');
          continue;
        }
        mark(entry.clientItemKey, 'running');
        try {
          const name = entry.relativePath.split('/').at(-1)!;
          const created = await globalSlots.current.use(() =>
            client.ensureFolder(teamId, {
              name,
              parentMaterialId: parent.materialId
            })
          );
          resolved.set(entry.clientItemKey, {
            driveFolderId: created.folderId,
            materialId: created.materialId
          });
          mark(entry.clientItemKey, 'succeeded');
        } catch (cause) {
          mark(entry.clientItemKey, 'failed', errorCode(cause));
        }
      }

      group.stage = 'transferring';
      update();
      const files = request.manifest.entries.filter(entry => entry.kind === 'file');
      let next = 0;
      const transfer = async (entry: (typeof files)[number]) => {
        const parent = parentOf(entry.parentKey);
        if (!parent) {
          mark(entry.clientItemKey, 'skipped', 'PARENT_FAILED');
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
            mark(entry.clientItemKey, 'failed', 'CONFLICT_NEEDS_DECISION');
            return;
          }
          try {
            choice = await request.onConflict({
              name,
              parentKey: entry.parentKey,
              existingMaterialId
            });
          } catch (cause) {
            mark(entry.clientItemKey, 'failed', errorCode(cause));
            return;
          }
        }
        if (choice === 'skip') {
          mark(entry.clientItemKey, 'skipped');
          return;
        }
        mark(entry.clientItemKey, 'running');
        try {
          await globalSlots.current.use(() =>
            client.uploadFile({
              teamId,
              destinationFolderId: parent.driveFolderId,
              file: entry.source,
              conflictMode: 'keep_both',
              replaceMaterialId: null,
              versionOfMaterialId: choice === 'replace' ? (existingMaterialId ?? null) : null
            })
          );
          mark(entry.clientItemKey, 'succeeded');
        } catch (cause) {
          mark(entry.clientItemKey, 'failed', errorCode(cause));
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
      try {
        await request.confirmCatalog();
        group.state = terminalState(group, request.manifest.issues.length);
      } catch {
        group.state = group.items.some(item => item.state === 'succeeded') ? 'partial' : 'failed';
      }
      group.stage = 'done';
      update();
      return group;
    },
    [client, publish, teamId]
  );

  const value = useMemo<WorkspaceOperationsValue>(
    () => ({ groups, startUploadGroup }),
    [groups, startUploadGroup]
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
