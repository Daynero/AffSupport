import { useCallback, useRef, useState } from 'react';
import { teamApi } from '../../api/team';
import type {
  MaterialKind,
  TeamAnalyticsAction,
  TeamAnalyticsOutcome,
  TeamAnalyticsStorage,
  TranscriptIngestState
} from '@video-compressor/shared';
import {
  completeTeamFileAttempt,
  startTeamFileAttempt,
  teamAnalyticsSizeBucket
} from '../../analytics/service';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessage } from '../errors';
import {
  defaultMaterialActionsClient,
  type MaterialActionsClient,
  type TeamFileUploadInput
} from './material-actions-client';

export type { MaterialActionsClient, TeamFileUploadInput };

/**
 * The little a row action needs to know about a material.
 *
 * Deliberately narrower than `CatalogMaterialItem`: the Files browser lists
 * `TeamMaterialSummary` rows, and requiring the full search shape is what kept
 * file actions confined to the search results (finding F1). Both shapes satisfy
 * this one structurally.
 */
export interface RowMaterial {
  id: string;
  teamId: string;
  name: string;
  kind: MaterialKind;
  category?: string | null;
  fileExtension?: string | null;
  sizeBytes?: number | null;
  transcriptIngestState?: TranscriptIngestState;
}

/**
 * Every file operation on one material, with no opinion about how it looks.
 *
 * Splitting this out of the old `MaterialActions` component is what lets a row
 * menu mount its contents only when opened: a list of fifty rows used to mount
 * fifty copies of this state, eight hooks and two file inputs each, whether or
 * not anyone opened them (SC-009).
 *
 * Failures surface as machine codes, never as sentences. The code is the
 * contract; turning it into human copy is the caller's job, through the one
 * mapper in `team/errors.ts` (constitution V, FR-014).
 */
/**
 * What a completed action says out loud.
 *
 * Every mutation confirms; `download` does not, because the file arriving is
 * its own confirmation and a toast for it would be noise (FR-013 asks for one
 * visible outcome per action, not one toast per call).
 */
const SUCCESS_COPY: Partial<Record<TeamAnalyticsAction, TranslationKey>> = {
  upload: 'teamToastUploaded',
  rename: 'teamToastRenamed',
  move: 'teamToastMoved',
  trash: 'teamToastTrashed'
};

export function useMaterialActions(input: {
  teamId: string;
  material: RowMaterial;
  client?: MaterialActionsClient;
  storageKind?: TeamAnalyticsStorage | null;
  /** Folder a new version or an upload lands in; null when unknown. */
  destinationFolderId?: string | null;
  /** Called after any operation that changed something on the server. */
  onChanged: () => void;
}) {
  const {
    teamId,
    material,
    client = defaultMaterialActionsClient,
    storageKind = null,
    destinationFolderId = null,
    onChanged
  } = input;

  const { t } = useI18n();
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [conflictFile, setConflictFile] = useState<File | null>(null);
  const attemptNumbers = useRef<Partial<Record<TeamAnalyticsAction, number>>>({});

  /**
   * The single place an outcome becomes visible.
   *
   * The old component put `Error.message` — the raw machine code — straight
   * into the page, and said nothing at all on success (findings S1, S2). Both
   * now go through the one mapper and the one channel.
   */
  const report = useCallback(
    (action: TeamAnalyticsAction, code: string | null, successKey?: TranslationKey | null) => {
      if (code) {
        push({ tone: 'error', text: teamErrorMessage(code, t) });
        return;
      }
      // `null` means the caller is raising its own confirmation — the trash
      // path does, because its toast carries the Undo.
      const success = successKey === undefined ? SUCCESS_COPY[action] : successKey;
      if (success) push({ tone: 'success', text: t(success) });
    },
    [push, t]
  );

  const beginAttempt = useCallback(
    (action: TeamAnalyticsAction, sizeBytes = material.sizeBytes ?? null) => {
      if (!storageKind) return null;
      const attemptNumber = (attemptNumbers.current[action] ?? 0) + 1;
      attemptNumbers.current[action] = attemptNumber;
      return startTeamFileAttempt({
        action,
        storageKind,
        sizeBucket: teamAnalyticsSizeBucket(sizeBytes),
        cacheState: 'unknown',
        attemptNumber
      });
    },
    [material.sizeBytes, storageKind]
  );

  /**
   * Runs one operation, reporting its analytics attempt either way.
   *
   * Resolves to the failing code rather than throwing, so a caller can react to
   * a specific one (an undo racing a purge, a name conflict) without a try/catch
   * around every call site.
   */
  const run = useCallback(
    async (
      action: TeamAnalyticsAction,
      work: () => Promise<unknown>,
      successKey?: TranslationKey | null
    ): Promise<string | null> => {
      const attempt = beginAttempt(action);
      setBusy(true);
      setErrorCode(null);
      try {
        await work();
        if (attempt) completeTeamFileAttempt(attempt, { outcome: 'success', retryable: false });
        onChanged();
        report(action, null, successKey);
        return null;
      } catch (caught) {
        if (attempt) {
          completeTeamFileAttempt(attempt, {
            outcome: analyticsOutcome(caught),
            retryable: retryableError(caught)
          });
        }
        const code = errorCodeOf(caught);
        setErrorCode(code);
        report(action, code);
        return code;
      } finally {
        setBusy(false);
      }
    },
    [beginAttempt, onChanged, report]
  );

  const upload = useCallback(
    async (
      file: File,
      conflictMode: TeamFileUploadInput['conflictMode'],
      exactReplacement: string | null = null,
      versionOf: string | null = null
    ): Promise<string | null> => {
      const uploadDestination = material.kind === 'folder' ? material.id : destinationFolderId;
      if (!uploadDestination) {
        setErrorCode('INVALID_INPUT');
        return 'INVALID_INPUT';
      }
      const attempt = beginAttempt('upload', file.size);
      setBusy(true);
      setErrorCode(null);
      try {
        await client.uploadFile({
          teamId,
          destinationFolderId: uploadDestination,
          file,
          conflictMode,
          replaceMaterialId: exactReplacement,
          versionOfMaterialId: versionOf
        });
        if (attempt) completeTeamFileAttempt(attempt, { outcome: 'success', retryable: false });
        setConflictFile(null);
        onChanged();
        report('upload', null);
        return null;
      } catch (caught) {
        if (attempt) {
          completeTeamFileAttempt(attempt, {
            outcome: analyticsOutcome(caught),
            retryable: retryableError(caught)
          });
        }
        const code = errorCodeOf(caught);
        // A name clash is a question for the person, not a failure: hold the
        // file so they can answer keep-both or replace, and say nothing yet.
        if (code === 'NAME_CONFLICT') {
          setConflictFile(file);
        } else {
          setErrorCode(code);
          report('upload', code);
        }
        return code;
      } finally {
        setBusy(false);
      }
    },
    [
      beginAttempt,
      client,
      destinationFolderId,
      material.id,
      material.kind,
      onChanged,
      report,
      teamId
    ]
  );

  const download = useCallback(
    () =>
      run('download', async () => {
        try {
          const grant = await client.requestDownload(teamId, material.id, 'browser');
          if (grant.kind === 'agent') {
            await client.downloadWithAgent({
              transferUrl: grant.transferUrl,
              transferGrant: grant.grant,
              fileName: material.name
            });
            return;
          }
          const anchor = document.createElement('a');
          anchor.href = grant.rangeUrl;
          anchor.download = material.name;
          anchor.rel = 'noreferrer';
          anchor.click();
        } catch (caught) {
          // A browser grant can be refused for a file only the local agent can
          // fetch; ask again for the agent path before giving up.
          if (errorCodeOf(caught) !== 'AGENT_REQUIRED') throw caught;
          const grant = await client.requestDownload(teamId, material.id, 'agent');
          if (grant.kind !== 'agent') throw new Error('INVALID_RESPONSE', { cause: caught });
          await client.downloadWithAgent({
            transferUrl: grant.transferUrl,
            transferGrant: grant.grant,
            fileName: material.name
          });
        }
      }),
    [client, material.id, material.name, run, teamId]
  );

  const rename = useCallback(
    (newName: string) =>
      run('rename', async () => {
        const result = await client.renameMaterial({
          teamId,
          materialId: material.id,
          newName,
          conflictMode: 'cancel',
          idempotencyKey: crypto.randomUUID()
        });
        // 012 (T008): the transcript companion follows the video's name.
        if (material.category === 'video') {
          const companion = await teamApi
            .getTranscriptCompanion(teamId, material.id)
            .catch(() => null);
          if (companion) {
            const stem = newName.replace(/\.[^.]+$/u, '');
            await client
              .renameMaterial({
                teamId,
                materialId: companion.id,
                newName: `${stem}.txt`,
                conflictMode: 'keep_both',
                idempotencyKey: crypto.randomUUID()
              })
              .catch(() => undefined);
          }
        }
        return result;
      }),
    [client, material.category, material.id, run, teamId]
  );

  const move = useCallback(
    (folderId: string) =>
      run('move', async () => {
        // The picker names the space root with a `'root'` sentinel; the move API
        // expects `null` there. Passing the literal string moves nothing.
        const destination = folderId === 'root' ? null : folderId;
        const result = await client.moveMaterial({
          teamId,
          materialId: material.id,
          destinationFolderId: destination,
          conflictMode: 'cancel',
          idempotencyKey: crypto.randomUUID()
        });
        // 012 (T009): the transcript companion follows the video's place.
        if (material.category === 'video') {
          const companion = await teamApi
            .getTranscriptCompanion(teamId, material.id)
            .catch(() => null);
          if (companion) {
            await client
              .moveMaterial({
                teamId,
                materialId: companion.id,
                destinationFolderId: destination,
                conflictMode: 'keep_both',
                idempotencyKey: crypto.randomUUID()
              })
              .catch(() => undefined);
          }
        }
        return result;
      }),
    [client, material.category, material.id, run, teamId]
  );

  const restore = useCallback(
    () =>
      run(
        'trash',
        () =>
          client.restoreMaterial({
            teamId,
            materialId: material.id,
            idempotencyKey: crypto.randomUUID()
          }),
        'teamToastRestored'
      ),
    [client, material.id, run, teamId]
  );

  /**
   * Trashing asks nothing and offers Undo instead.
   *
   * A confirmation before a reversible action is friction charged for nothing:
   * it costs a click every time to prevent a mistake that costs one click to
   * fix (FR-028). The undo is a fresh operation with its own idempotency key,
   * and a race — the item already restored, or purged from Drive — surfaces as
   * the operation's own mapped code rather than as silence.
   */
  const trash = useCallback(async () => {
    const code = await run(
      'trash',
      () =>
        client.trashMaterial({
          teamId,
          materialId: material.id,
          idempotencyKey: crypto.randomUUID()
        }),
      null
    );
    if (code) return code;
    push({
      tone: 'success',
      text: t('teamToastTrashed'),
      action: { label: t('teamUndo'), run: () => void restore() }
    });
    return null;
  }, [client, material.id, push, restore, run, t, teamId]);

  return {
    busy,
    errorCode,
    clearError: useCallback(() => setErrorCode(null), []),
    conflictFile,
    clearConflict: useCallback(() => setConflictFile(null), []),
    upload,
    download,
    rename,
    move,
    trash,
    restore
  };
}

function errorCodeOf(error: unknown) {
  return error instanceof Error ? error.message : 'PROCESS_FAILED';
}

function retryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return ['RATE_LIMITED', 'DRIVE_UNAVAILABLE', 'DELIVERY_UNAVAILABLE'].includes(errorCodeOf(error));
}

function analyticsOutcome(error: unknown): TeamAnalyticsOutcome {
  const code = errorCodeOf(error);
  if (code === 'UNSUPPORTED_MEDIA' || code === 'TOO_LARGE') return 'unsupported';
  if (code === 'ABORTED' || code === 'CANCELED') return 'cancelled';
  if (
    [
      'AGENT_REQUIRED',
      'AGENT_UPDATE_REQUIRED',
      'NAME_CONFLICT',
      'NOT_A_MEMBER',
      'PERMISSION_DENIED',
      'ROOT_ESCAPE'
    ].includes(code)
  ) {
    return 'blocked';
  }
  return 'failure';
}
