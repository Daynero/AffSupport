import { useEffect, useId, useRef, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n, type TranslationKey } from '../../i18n';
import type { LibraryRequirementScanResult } from '../../api/team';
import { teamErrorMessage } from '../errors';
import { useLibraryProcessing } from './LibraryProcessingProvider';
import type { LibraryBatchScope } from './process-library-contract';

export {
  stableLibraryAgentInstanceId,
  type LibraryBatchScope,
  type ProcessLibraryAgent,
  type ProcessLibraryClient
} from './process-library-contract';

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * A window onto the space's batch, not the batch itself.
 *
 * Everything that runs lives in `LibraryProcessingProvider`; closing this
 * dialog now changes nothing about the work (finding B1, FR-032). Cancelling is
 * a separate, confirmed decision — which is what closing a window used to mean
 * by accident.
 */
export function ProcessLibraryDialog({
  scope = { kind: 'space' },
  agentCompatible,
  onClose
}: {
  scope?: LibraryBatchScope;
  agentCompatible: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const batch = useLibraryProcessing();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancelTitleId = useId();

  /*
   * A window opened onto a batch that is not running scans, so the counts are
   * current. Only `idle` used to qualify — so after a cancel or a failure the
   * window kept the numbers from before: fifty-nine jobs offered for a space
   * with forty-nine left, beside a "done: 10" line from a run that was over.
   * A run in flight is still left alone; a rescan mid-run would fight the loop.
   */
  const settledPhase =
    batch.phase === 'idle' ||
    batch.phase === 'canceled' ||
    batch.phase === 'complete' ||
    batch.phase === 'failed';
  const rescan = batch.rescan;
  const scanned = useRef(false);
  useEffect(() => {
    if (!settledPhase) {
      scanned.current = false;
      return;
    }
    if (scanned.current) return;
    scanned.current = true;
    void rescan();
  }, [rescan, settledPhase]);

  const running = batch.phase === 'running';
  /* While a run is on, its own tally; once it has settled, the result it kept —
     the live counters are cleared by the rescan that follows. */
  const tally = running
    ? { done: batch.done, skipped: batch.skipped, failed: batch.failed }
    : (batch.outcome ?? { done: batch.done, skipped: batch.skipped, failed: batch.failed });
  const settled = tally.done + tally.skipped + tally.failed;
  /*
   * How many of the folder's videos already carry a transcript: the videos the
   * walk found, less the transcription jobs the scan still wants. Counted in
   * videos and jobs that are one to one, because they are — a translation is a
   * second job for the same video, and taking it from a file count made the
   * window claim four landings were "already processed" on the same screen
   * where it said this computer cannot process landings at all.
   */
  const alreadyDone =
    batch.scope.kind === 'folder' &&
    batch.scope.videos !== undefined &&
    batch.scan &&
    batch.supportedKinds.includes('transcription')
      ? Math.max(0, batch.scope.videos - batch.scan.missing.transcription)
      : 0;
  /* What was asked for while something else was running. Compared by the words
     rather than by identity: the shell rebuilds the object on every render. */
  const deferred = running && batchScopeName(scope, t) !== batchScopeName(batch.scope, t);

  return (
    <Modal
      labelledBy="team-batch-window-title"
      onClose={onClose}
      closeLabel={t('teamClose')}
      /* The heading, not the first control. Focus landed on ✕, so opening this
         window and pressing Enter closed it again; putting it on the primary
         instead would mean Enter starts a batch over the whole space. */
      initialFocus="#team-batch-window-title"
      size="xl"
    >
      <section className="team-batch">
        <h2 id="team-batch-window-title" tabIndex={-1}>
          {batchTitle(batch.scope, t)}
        </h2>
        {/* The scope again, in a full sentence: the title has to be short, and
            "the whole space" versus "the 4 files you picked" is exactly the
            thing a person checks before pressing Start. */}
        <p className="team-batch-scope">{batchScopeLine(batch.scope, t)}</p>
        {/*
         * A batch already running keeps the window: its numbers, its progress
         * and its name. Asking for a different scope while it runs used to put
         * the new title over the old run's progress bar, with no Start and no
         * word that the request had been put aside until this one finishes.
         */}
        {deferred && (
          <p className="team-inline-notice" role="status">
            {t('teamBatchScopeDeferred', { scope: batchScopeName(scope, t) })}
          </p>
        )}
        {batch.phase === 'scanning' && <p aria-live="polite">{t('teamBatchScanning')}</p>}
        {batch.scan && (
          <>
            {/* Only the kinds this computer will actually claim. A tile for
                work the agent cannot do is a number that never moves: the
                folder batch promised six landing jobs and finished eighteen of
                twenty-four, calling itself complete. */}
            <div className="team-batch-counts" role="group" aria-label={t('teamBatchCounts')}>
              {/* `batch.scope`, like the title above: these are the running
                  batch's numbers, not the scope somebody has just asked for. */}
              {countable(batch.scan, batch.supportedKinds, batch.scope.kind === 'space').map(
                entry => (
                  <div key={entry.key}>
                    <strong>{entry.count}</strong>
                    <span>{t(entry.label)}</span>
                  </div>
                )
              )}
            </div>
            {/* What is left over says so, rather than sitting in a tile that
                looks like part of the plan. */}
            {unsupported(batch.scan, batch.supportedKinds).length > 0 && (
              <p className="team-explorer-muted">
                {t('teamBatchUnsupportedWork', {
                  work: unsupported(batch.scan, batch.supportedKinds)
                    .map(entry => `${t(entry.label)} — ${entry.count}`)
                    .join(', ')
                })}
              </p>
            )}
          </>
        )}
        {batch.phase === 'ready' && batch.total > 0 && (
          <p>
            {t('teamBatchConfirmation', { count: batch.total })}
            {/* Where the difference went. A folder of twenty-four videos with
                two transcripts already in it offers twenty-two jobs, and the
                other two used to vanish between one line and the next. */}
            {alreadyDone > 0 ? ` ${t('teamBatchAlreadyDone', { count: alreadyDone })}` : ''}
          </p>
        )}
        {batch.phase === 'ready' && batch.total === 0 && <p>{t('teamBatchNothing')}</p>}
        {!agentCompatible && <p className="team-inline-error">{t('teamProcessAgentUpdate')}</p>}
        {agentCompatible && batch.supportedKinds.length === 0 && (
          <p className="team-inline-error">{t('teamProcessToolUpdate')}</p>
        )}
        {batch.phase === 'running' && (
          <div className="team-batch-progress" aria-live="polite">
            <progress max={Math.max(batch.total, settled, 1)} value={settled} />
            <span>
              {t('teamBatchProgress', {
                completed: tally.done,
                total: Math.max(batch.total, settled)
              })}
            </span>
            {batch.activeKind && (
              /* The kind in the person's own words. This printed the machine's
                 token — "Зараз обробляється: transcription" — in a Ukrainian
                 window. */
              <small>{t('teamBatchActive', { kind: t(KIND_NOUN[batch.activeKind]) })}</small>
            )}
          </div>
        )}
        {settled > 0 && (
          <p>
            {t('teamBatchResults', {
              completed: tally.done,
              skipped: tally.skipped,
              failed: tally.failed
            })}
          </p>
        )}
        {/* The run's own ending, held while the counts move on to what is
            left: a rescan that erased this made the window forget, in one
            frame, what the person had just watched happen. */}
        {batch.outcome?.kind === 'canceled' && <p>{t('teamBatchCanceled')}</p>}
        {batch.outcome?.kind === 'complete' && <p>{t('teamBatchComplete')}</p>}
        {batch.errorCode && (
          <p className="team-inline-error">{teamErrorMessage(batch.errorCode, t)}</p>
        )}
        <div className="team-dialog-actions">
          {batch.phase !== 'running' && batch.total > 0 && (
            <Button type="button" variant="primary" onClick={() => void batch.start()}>
              {t('teamBatchStart')}
            </Button>
          )}
          {batch.phase === 'running' && (
            <Button type="button" variant="secondary" onClick={() => setConfirmingCancel(true)}>
              {t('teamBatchCancel')}
            </Button>
          )}
          {tally.failed > 0 && !running && (
            <Button type="button" variant="secondary" onClick={() => void batch.retryFailed()}>
              {t('teamBatchRetry')}
            </Button>
          )}
          {/* "Close" closes the window; the run, if any, carries on. It said
              "Done", which reads as a decision — and pressing it having done
              nothing at all felt like agreeing to something. */}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamClose')}
          </Button>
        </div>
      </section>
      {confirmingCancel && (
        <Modal
          nested
          labelledBy={cancelTitleId}
          size="sm"
          onClose={() => setConfirmingCancel(false)}
        >
          <h3 id={cancelTitleId}>{t('teamBatchCancelConfirmTitle')}</h3>
          <p>{t('teamBatchCancelConfirmBody')}</p>
          <div className="team-dialog-actions">
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmingCancel(false);
                void batch.cancel();
              }}
            >
              {t('teamBatchCancel')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmingCancel(false)}>
              {t('teamCancel')}
            </Button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

/** What one job of each kind is called, for the line naming the one running. */
const KIND_NOUN: Record<string, TranslationKey> = {
  transcription: 'teamBatchKindTranscription',
  translation: 'teamBatchKindTranslation',
  landing_optimization: 'teamBatchKindLanding'
};

/** The three kinds, paired with the count and the word the window uses. */
const KIND_TILES = [
  { key: 'transcription', label: 'teamBatchTranscriptions' },
  { key: 'translation', label: 'teamBatchTranslations' },
  { key: 'landing_optimization', label: 'teamBatchLandings' }
] as const;

type KindTile = { key: string; label: TranslationKey; count: number };

function tilesOf(scan: LibraryRequirementScanResult): KindTile[] {
  return [
    { ...KIND_TILES[0], count: scan.missing.transcription },
    { ...KIND_TILES[1], count: scan.missing.translation },
    { ...KIND_TILES[2], count: scan.missing.landingOptimization }
  ];
}

/*
 * The tiles worth a place: what this computer will claim, and either has some
 * of or is being asked about wholesale. A batch over two videos does not need
 * a landings tile reading zero; the whole space keeps all three, because there
 * the zero is the answer to a question that was asked.
 */
function countable(
  scan: LibraryRequirementScanResult,
  supported: readonly string[],
  wholeSpace: boolean
): KindTile[] {
  return tilesOf(scan).filter(
    tile => supported.includes(tile.key) && (wholeSpace || tile.count > 0)
  );
}

function unsupported(scan: LibraryRequirementScanResult, supported: readonly string[]): KindTile[] {
  return tilesOf(scan).filter(tile => !supported.includes(tile.key) && tile.count > 0);
}

function batchTitle(scope: LibraryBatchScope, t: Translate): string {
  if (scope.kind === 'folder') return t('teamBatchTitleFolder', { name: scope.name });
  if (scope.kind === 'selection') return t('teamBatchTitleSelection', { count: scope.count });
  return t('teamBatchTitleSpace');
}

/** The scope as a noun phrase, for a sentence that already has a sentence. */
function batchScopeName(scope: LibraryBatchScope, t: Translate): string {
  if (scope.kind === 'folder') return t('teamBatchScopeShortFolder', { name: scope.name });
  if (scope.kind === 'selection') return t('teamBatchScopeShortSelection', { count: scope.count });
  return t('teamBatchScopeShortSpace');
}

function batchScopeLine(scope: LibraryBatchScope, t: Translate): string {
  if (scope.kind === 'folder') {
    // The walk knows how far it went; saying so is what the old folder window
    // did well and this one dropped.
    return scope.folders !== undefined && scope.files !== undefined
      ? t('teamBatchScopeFolderCounted', {
          name: scope.name,
          folders: scope.folders,
          files: scope.files
        })
      : t('teamBatchScopeFolder', { name: scope.name });
  }
  if (scope.kind === 'selection') {
    // "обрано 5, придатних до обробки 3" — otherwise the files that cannot be
    // processed simply vanish between the bar and the window.
    return scope.picked !== undefined && scope.picked > scope.count
      ? t('teamBatchScopeSelectionPartial', { count: scope.count, picked: scope.picked })
      : t('teamBatchScopeSelection', { count: scope.count });
  }
  return t('teamBatchScopeSpace');
}
