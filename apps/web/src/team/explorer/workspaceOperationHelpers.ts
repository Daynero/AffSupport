import type { LocalOperationStage, LocalOperationState } from '@video-compressor/shared';
import type { TranslationKey } from '../../i18n';
import type { JournalGroup } from './workspaceOperationJournal';
import type { WorkspaceOperationGroup } from './WorkspaceOperationsProvider';

/*
 * The pure parts of the space's upload groups, out of `WorkspaceOperationsProvider` (070,
 * SC-004: no file in team/explorer over 800 lines): a journalled group read back into a live
 * one, a small semaphore for parallel transfers, an error's code, a finished group's state, and
 * the words for each stage.
 */

export function fromJournal(group: JournalGroup): WorkspaceOperationGroup {
  return {
    id: group.id,
    teamId: group.teamId,
    createdAt: group.createdAt,
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

export class Semaphore {
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

export function errorCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string')
    return cause.code;
  return 'DRIVE_UNAVAILABLE';
}

export function terminalState(
  group: WorkspaceOperationGroup,
  issueCount: number
): LocalOperationState {
  const succeeded = group.items.filter(item => item.state === 'succeeded').length;
  const failed = group.items.some(item => item.state === 'failed' || item.state === 'skipped');
  if (!failed && issueCount === 0) return 'succeeded';
  return succeeded > 0 ? 'partial' : 'failed';
}

export const STAGE_LABEL: Record<LocalOperationStage, TranslationKey> = {
  preparing: 'teamWorkspaceStagePreparing',
  creating_folders: 'teamWorkspaceStageFolders',
  transferring: 'teamWorkspaceStageTransfer',
  moving: 'teamWorkspaceStageMoving',
  updating_catalog: 'teamWorkspaceStageCatalog',
  done: 'teamOperationSucceeded'
};
