import { useEffect, useId } from 'react';
import { Alert, ErrorState, RadioGroup, Spinner } from '../../components/ui/index';
import { useI18n, type TranslationKey } from '../../i18n';
import type { CompressPlan } from '../explorer/TeamCompressorDialog';
import { TeamCompressorDialog } from '../explorer/TeamCompressorDialog';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { ProcessLibraryDialog } from '../library/ProcessLibraryDialog';
import { useLibraryProcessing } from '../library/LibraryProcessingProvider';
import type { LibraryBatchScope } from '../library/process-library-contract';
import {
  BATCH_SCOPE_LIMIT,
  sameLibraryScope,
  useProcessScope,
  type FolderSubtreeClient,
  type ProcessOrigin,
  type ProcessScopeKind,
  type ProcessScopeState,
  type ScopeResolution
} from './processScope';

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * One door to processing (070, T061; from 024 T093).
 *
 * "Process this folder", "compress this folder", the selection bar's Process
 * and the space menu's "process everything" used to be three windows with three
 * vocabularies: a folder walk that opened a second window, a batch window titled
 * by whoever opened it, and a compressor that could only take what it was
 * handed. Now every door opens this, on the scope it came from, with every other
 * scope it can name beside it — the files in hand, this folder, the whole space.
 *
 * Underneath it is still the space's batch window (processing) or the
 * compressor's window (compression): the chooser and its answer sit at the top
 * of the one that does the work, so there is no hand-off between two dialogs.
 *
 * What it guards, in order:
 * - a scope that is still being read cannot be started;
 * - a scope over {@link BATCH_SCOPE_LIMIT} files says so *before* Start, not
 *   after the server refused it;
 * - an empty scope is never handed on — the server reads "no ids" as the whole
 *   space, so a folder that yielded nothing would quietly start everything.
 */
export function ProcessScopeDialog({
  teamId,
  origin,
  client,
  onClose,
  scope,
  onScope,
  onCompress
}: {
  teamId: string;
  origin: ProcessOrigin;
  client: FolderSubtreeClient & FolderPickerClient;
  onClose: () => void;
  /** Processing: the scope the space's batch was last pointed at. */
  scope?: LibraryBatchScope;
  /** Processing: point the space's batch at these files, under these words. */
  onScope?: (ids: string[], scope: LibraryBatchScope) => void;
  /** Compression: run this plan. */
  onCompress?: (plan: CompressPlan) => void;
}) {
  const state = useProcessScope(teamId, origin, client);
  if (origin.intent === 'compress') {
    const ready = state.resolution.state === 'ready' ? state.resolution : null;
    return (
      <TeamCompressorDialog
        teamId={teamId}
        client={client}
        items={(ready?.videos ?? []).map(video => ({
          id: video.id,
          name: video.name,
          folderId: video.parentFolderId ?? null
        }))}
        scope={<ProcessScopeChooser state={state} origin={origin} />}
        onRun={plan => onCompress?.(plan)}
        onClose={onClose}
      />
    );
  }
  return (
    <ProcessBatchScope
      state={state}
      origin={origin}
      scope={scope ?? { kind: 'space' }}
      onScope={onScope}
      onClose={onClose}
    />
  );
}

/** Processing: the space's batch window, pointed at what the chooser resolved. */
function ProcessBatchScope({
  state,
  origin,
  scope,
  onScope,
  onClose
}: {
  state: ProcessScopeState;
  origin: ProcessOrigin;
  scope: LibraryBatchScope;
  onScope?: (ids: string[], scope: LibraryBatchScope) => void;
  onClose: () => void;
}) {
  const batch = useLibraryProcessing();
  const resolution = state.resolution;
  const ready = resolution.state === 'ready' ? resolution : null;
  const running = batch.phase === 'running';
  /* Handed on once per answer, and only an answer that names files — or the space itself. */
  const readyKey = ready ? `${ready.library.kind}|${ready.ids.join(',')}` : '';
  /* Keyed on the answer, not on its object or on the caller's callback, which the shell
     rebuilds on every render: handing the same scope over again would reset the batch. */
  useEffect(() => {
    if (!ready || running) return;
    onScope?.(ready.ids, ready.library);
  }, [readyKey, running]);
  /*
   * Start waits until the batch is about the scope on screen: the provider
   * takes a new scope on its next render, and a scan begun in between would
   * count the previous one.
   */
  const applied = ready !== null && sameLibraryScope(batch.scope, ready.library);
  const { t } = useI18n();
  return (
    <ProcessLibraryDialog
      scope={ready?.library ?? scope}
      scopeChooser={<ProcessScopeChooser state={state} origin={origin} locked={running} />}
      blocked={!running && !applied}
      blockedReason={
        BLOCKED_REASON[resolution.state] ? t(BLOCKED_REASON[resolution.state]!) : undefined
      }
      onClose={onClose}
    />
  );
}

/** Why Start is off, said beside it; a scope being handed over says nothing — it is a moment. */
const BLOCKED_REASON: Partial<Record<ScopeResolution['state'], TranslationKey>> = {
  walking: 'processScopeBlockedReading',
  failed: 'processScopeBlockedFailed',
  empty: 'processScopeBlockedEmpty',
  'too-deep': 'processScopeBlockedEmpty',
  'too-many': 'processScopeBlockedTooMany'
};

/**
 * The scopes this door can offer and what the chosen one holds. Alone — one
 * scope — it is only the answer: a radio group of one is a question with no
 * choice in it.
 */
export function ProcessScopeChooser({
  state,
  origin,
  locked = false
}: {
  state: ProcessScopeState;
  origin: ProcessOrigin;
  locked?: boolean;
}) {
  const { t } = useI18n();
  const statusId = useId();
  const { kinds, kind, setKind } = state;
  return (
    <div className="team-process-scope">
      {kinds.length > 1 && (
        <RadioGroup<ProcessScopeKind>
          label={t(
            origin.intent === 'compress' ? 'processScopeCompressLabel' : 'processScopeLabel'
          )}
          value={kind}
          disabled={locked}
          onChange={setKind}
          options={kinds.map(option => ({
            value: option,
            label: scopeLabel(option, origin, t),
            description: scopeDescription(option, origin, state, t)
          }))}
        />
      )}
      <div id={statusId} className="team-process-scope-status" aria-live="polite">
        <ScopeStatus state={state} origin={origin} t={t} />
      </div>
    </div>
  );
}

function ScopeStatus({
  state,
  origin,
  t
}: {
  state: ProcessScopeState;
  origin: ProcessOrigin;
  t: Translate;
}) {
  const resolution = state.resolution;
  switch (resolution.state) {
    case 'walking':
      /* One read, so one line: the folder-by-folder count it used to tick
         through belonged to a walk that ran from here. */
      return (
        <p className="team-batch-scanning">
          <Spinner />
          {t('teamBatchScanningFolderOnce')}
        </p>
      );
    case 'failed':
      return <ErrorState message={t('teamFolderPickerFailed')} />;
    case 'too-deep':
      /* Not a failure — the walk hit a ceiling and is saying how to get past
         it, which is a different kind of message from "this went wrong". */
      return (
        <Alert color="warning" variant="soft">
          {t('teamBatchFolderTooDeep', { count: resolution.foldersVisited })}
        </Alert>
      );
    case 'too-many':
      /* The count that triggered the refusal, not every file the walk saw:
         compressing six hundred videos beside eighty landings is six hundred. */
      return (
        <Alert color="error" variant="soft">
          {t(
            state.kind === 'selection' ? 'processScopeSelectionTooMany' : 'teamBatchFolderTooMany',
            {
              count: resolution.count,
              limit: BATCH_SCOPE_LIMIT
            }
          )}
        </Alert>
      );
    case 'empty':
      return (
        <p className="team-explorer-muted">
          {resolution.reason === 'selection'
            ? t(
                origin.intent === 'compress'
                  ? 'processScopeSelectionNoVideos'
                  : 'processScopeSelectionNone'
              )
            : t(origin.intent === 'compress' ? 'teamBatchFolderNoVideos' : 'teamBatchFolderEmpty', {
                count: resolution.foldersVisited ?? 0
              })}
        </p>
      );
    case 'ready':
      return resolution.truncatedAfter !== undefined ? (
        <Alert color="warning" variant="soft">
          {t('teamFolderProcessTruncated', { count: resolution.truncatedAfter })}
        </Alert>
      ) : null;
  }
}

function scopeLabel(kind: ProcessScopeKind, origin: ProcessOrigin, t: Translate): string {
  if (kind === 'space') return t('processScopeSpace');
  if (kind === 'folder') return t('processScopeFolder');
  const count = origin.selection?.length ?? 0;
  return count === 1 ? t('processScopeFile') : t('processScopeSelection', { count });
}

function scopeDescription(
  kind: ProcessScopeKind,
  origin: ProcessOrigin,
  state: ProcessScopeState,
  t: Translate
): string {
  if (kind === 'space') return t('teamBatchScopeSpace');
  if (kind === 'folder') {
    const name = origin.folder?.name ?? '';
    const counts = state.folderCounts;
    if (!counts) return t('teamBatchScopeFolder', { name });
    return t(
      origin.intent === 'compress' ? 'processScopeFolderVideos' : 'teamBatchScopeFolderCounted',
      {
        name,
        folders: Math.max(0, counts.foldersVisited - 1),
        files:
          origin.intent === 'compress'
            ? counts.videos.length
            : counts.videos.length + counts.landings.length
      }
    );
  }
  const selection = origin.selection ?? [];
  return selection.length === 1 ? (selection[0]?.name ?? '') : t('processScopeSelectionHint');
}
