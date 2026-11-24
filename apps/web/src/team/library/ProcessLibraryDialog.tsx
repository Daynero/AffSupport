import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../../components/Modal';
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
import {
  Alert,
  Button,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  Progress
} from '../../components/ui/index';
import { ReconnectAction } from '../../components/ReconnectAction';

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
  scopeChooser,
  blocked = false,
  blockedReason,
  onClose
}: {
  scope?: LibraryBatchScope;
  /** The scope question (070, T061), asked above the work it decides. */
  scopeChooser?: ReactNode;
  /**
   * The scope on screen is not one the batch can be about yet — still being
   * read, empty, or more than one batch can take. Nothing is scanned and Start
   * stays off; `blockedReason` says why beside it.
   */
  blocked?: boolean;
  blockedReason?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const batch = useLibraryProcessing();
  // The reason, not a boolean (032 FR-013): "update Soty" is said only of an
  // agent that answered and is too old; a lost link asks for the link back.
  const agentReady = batch.agentAvailability === 'ready';
  const [confirmingCancel, setConfirmingCancel] = useState(false);

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
  /* Which scope the counts on screen were read for. A scope chosen in the
     window after a failed scan is a new question, not the same one again. */
  const scanned = useRef<string | null>(null);
  const appliedKey = `${batch.scope.kind}|${batchScopeName(batch.scope, t)}`;
  useEffect(() => {
    if (!settledPhase) {
      scanned.current = null;
      return;
    }
    if (blocked || scanned.current === appliedKey) return;
    scanned.current = appliedKey;
    void rescan();
  }, [appliedKey, blocked, rescan, settledPhase]);

  const running = batch.phase === 'running';
  const blockedReasonId = useId();
  /* While blocked, the counts on screen belong to a scope that is not the one chosen. */
  const showWork = !blocked || running;
  /* While a run is on, its own tally; once it has settled, the result it kept —
     the live counters are cleared by the rescan that follows. */
  const tally = running
    ? { done: batch.done, skipped: batch.skipped, failed: batch.failed }
    : (batch.outcome ?? { done: batch.done, skipped: batch.skipped, failed: batch.failed });
  const settled = tally.done + tally.skipped + tally.failed;
  /*
   * How many of the folder's videos already carry a transcript: the videos the
   * walk found, less the transcription jobs the scan still wants. Counted in
   * videos and original transcription jobs that are one to one. Taking all work
   * from a file count made the
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
          {/* The run's own name while it runs; before that, the scope on screen —
              a chooser that says "this folder" under "the whole space" was two answers. */}
          {batchTitle(running || !scopeChooser ? batch.scope : scope, t)}
        </h2>
        {/* The scope again, in a full sentence: the title has to be short, and
            "the whole space" versus "the 4 files you picked" is exactly the
            thing a person checks before pressing Start. */}
        {scopeChooser ?? <p className="team-batch-scope">{batchScopeLine(batch.scope, t)}</p>}
        {/*
         * A batch already running keeps the window: its numbers, its progress
         * and its name. Asking for a different scope while it runs used to put
         * the new title over the old run's progress bar, with no Start and no
         * word that the request had been put aside until this one finishes.
         */}
        {deferred && (
          <Alert className="team-inline-notice" color="info" variant="soft">
            {t('teamBatchScopeDeferred', { scope: batchScopeName(scope, t) })}
          </Alert>
        )}
        {showWork && batch.phase === 'scanning' && (
          <LoadingState count={2} label={t('teamBatchScanning')} />
        )}
        {showWork && batch.scan && (
          /*
           * What to run, chosen (024). The window used to count three kinds of
           * work in tiles and start all of them — a folder could not be
           * transcribed without also queueing its landings for the space. Each
           * kind is a row to tick, with how many it would make; a kind with
           * nothing to do says so and cannot be ticked.
           */
          <fieldset className="team-batch-choices">
            <legend className="visually-hidden">{t('teamBatchChoose')}</legend>
            {countable(batch.scan, batch.supportedKinds, true).map(entry => {
              const kind = entry.key as (typeof batch.chosenKinds)[number];
              const chosen = entry.count > 0 && batch.chosenKinds.includes(kind);
              return (
                <Checkbox
                  key={entry.key}
                  className={`team-batch-choice${entry.count === 0 ? ' is-empty' : ''}`}
                  checked={chosen}
                  disabled={entry.count === 0 || running}
                  onChange={checked =>
                    batch.setChosenKinds(
                      checked
                        ? [...batch.chosenKinds, kind]
                        : batch.chosenKinds.filter(item => item !== kind)
                    )
                  }
                  label={
                    <>
                      <span className="team-batch-choice-label">{t(entry.label)}</span>
                      <span className="team-batch-choice-count">
                        {entry.count === 0 ? t('teamBatchChoiceNothing') : entry.count}
                      </span>
                    </>
                  }
                />
              );
            })}
            {batch.scope.kind !== 'selection' && (
              <Checkbox
                className={`team-batch-choice${batch.previewCount === 0 ? ' is-empty' : ''}`}
                checked={batch.previewsChosen && batch.previewCount > 0}
                disabled={batch.previewCount === 0 || running}
                onChange={checked => batch.setPreviewsChosen(checked)}
                label={
                  <>
                    <span className="team-batch-choice-label">{t('teamBatchPreviews')}</span>
                    <span className="team-batch-choice-count">
                      {batch.previewCount === 0 ? t('teamBatchChoiceNothing') : batch.previewCount}
                    </span>
                  </>
                }
              />
            )}
          </fieldset>
        )}
        {showWork && batch.scan && batch.previewsChosen && batch.previewCount > 0 && (
          <p className="team-batch-note">{t('teamBatchPreviewsNote')}</p>
        )}
        {batch.previewError && (
          <Alert className="team-inline-error" color="warning" variant="soft" live="alert">
            {t('teamBatchPreviewsScanFailed')}
          </Alert>
        )}
        {showWork && batch.scan && unsupported(batch.scan, batch.supportedKinds).length > 0 && (
          <p className="team-explorer-muted">
            {t('teamBatchUnsupportedWork', {
              work: unsupported(batch.scan, batch.supportedKinds)
                .map(entry => `${t(entry.label)} — ${entry.count}`)
                .join(', ')
            })}
          </p>
        )}
        {showWork && batch.phase === 'ready' && alreadyDone > 0 && (
          <p className="team-batch-note">{t('teamBatchAlreadyDone', { count: alreadyDone })}</p>
        )}
        {/* "215" beside "Transcripts" under "Everything this space holds" read as every video
            being done again — the counts are only what is missing, and that is worth a line
            before a button that starts two hundred jobs. */}
        {showWork &&
          batch.phase === 'ready' &&
          alreadyDone === 0 &&
          batch.scan &&
          totalOf(batch.scan, batch.supportedKinds) > 0 && (
            <p className="team-batch-note">{t('teamBatchMissingOnly')}</p>
          )}
        {showWork &&
          batch.phase === 'ready' &&
          batch.scan &&
          totalOf(batch.scan, batch.supportedKinds) === 0 &&
          batch.previewCount === 0 && <EmptyState size="sm" title={t('teamBatchNothing')} />}
        {batch.agentAvailability === 'too_old' && batch.previewCount === 0 && (
          <Alert className="team-inline-error" color="warning" variant="soft" live="alert">
            {t('teamProcessAgentUpdate')}
          </Alert>
        )}
        {batch.agentAvailability === 'disconnected' && (
          <Alert
            className="team-inline-error"
            color="warning"
            variant="soft"
            live="alert"
            action={<ReconnectAction surface="team_library_dialog" />}
          >
            {t('linkConnectSoty')}
          </Alert>
        )}
        {batch.agentAvailability === 'blocked' && (
          <Alert className="team-inline-error" color="warning" variant="soft" live="alert">
            {t('linkBrowserBlocked')}
          </Alert>
        )}
        {batch.agentAvailability === 'account' && (
          <Alert className="team-inline-error" color="warning" variant="soft" live="alert">
            {t('entitlementBlocked')}
          </Alert>
        )}
        {agentReady && batch.supportedKinds.length === 0 && batch.previewCount === 0 && (
          <Alert className="team-inline-error" color="warning" variant="soft" live="alert">
            {t('teamProcessToolUpdate')}
          </Alert>
        )}
        {batch.phase === 'running' && (
          <div className="team-batch-progress" aria-live="polite">
            <Progress
              flowing
              label={t('teamBatchProgress', {
                completed: tally.done,
                total: Math.max(batch.total, settled)
              })}
              value={(settled / Math.max(batch.total, settled, 1)) * 100}
            />
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
          <p className="team-inline-error" role="alert">
            {teamErrorMessage(batch.errorCode, t)}
          </p>
        )}
        <div className="team-dialog-actions">
          {blocked && !running && blockedReason && (
            <span id={blockedReasonId} className="team-batch-blocked">
              {blockedReason}
            </span>
          )}
          {/* "Close" closes the window; the run, if any, carries on. It said
              "Done", which reads as a decision — and pressing it having done
              nothing at all felt like agreeing to something. */}
          <Button color="neutral" variant="ghost" onClick={onClose}>
            {t('teamClose')}
          </Button>
          {tally.failed > 0 && !running && !batch.previewsChosen && (
            <Button color="neutral" variant="outline" onClick={() => void batch.retryFailed()}>
              {t('teamBatchRetry')}
            </Button>
          )}
          {batch.phase === 'running' && (
            <Button color="neutral" variant="outline" onClick={() => setConfirmingCancel(true)}>
              {t('teamBatchCancel')}
            </Button>
          )}
          {/* A scope that cannot be started yet still shows where Start is,
              switched off, with the reason beside it (070, T061). */}
          {blocked && !running && (
            <Button
              color="primary"
              variant="solid"
              disabled
              aria-describedby={blockedReason ? blockedReasonId : undefined}
            >
              {t('teamProcessStart')}
            </Button>
          )}
          {showWork &&
            batch.phase !== 'running' &&
            agentReady &&
            batch.scan &&
            (totalOf(batch.scan, batch.supportedKinds) > 0 || batch.previewCount > 0) && (
              <Button
                color="primary"
                variant="solid"
                disabled={batch.total === 0}
                onClick={() => void batch.start()}
              >
                {t('teamBatchStartCount', { count: batch.total })}
              </Button>
            )}
        </div>
      </section>
      {confirmingCancel && (
        <ConfirmDialog
          nested
          title={t('teamBatchCancelConfirmTitle')}
          body={t('teamBatchCancelConfirmBody')}
          confirmLabel={t('teamBatchCancel')}
          cancelLabel={t('teamCancel')}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() => {
            setConfirmingCancel(false);
            void batch.cancel();
          }}
        />
      )}
    </Modal>
  );
}

/** What one job of each kind is called, for the line naming the one running. */
const KIND_NOUN: Record<string, TranslationKey> = {
  transcription: 'teamBatchKindTranscription',
  landing_optimization: 'teamBatchKindLanding',
  previews: 'teamBatchKindPreview'
};

/** The three kinds, paired with the count and the word the window uses. */
const KIND_TILES = [
  { key: 'transcription', label: 'teamBatchTranscriptions' },
  { key: 'landing_optimization', label: 'teamBatchLandings' }
] as const;

type KindTile = { key: string; label: TranslationKey; count: number };

function tilesOf(scan: LibraryRequirementScanResult): KindTile[] {
  return [
    { ...KIND_TILES[0], count: scan.missing.transcription },
    { ...KIND_TILES[1], count: scan.missing.landingOptimization }
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

/** Everything this computer could run here, chosen or not. */
function totalOf(scan: LibraryRequirementScanResult, supported: readonly string[]): number {
  return tilesOf(scan)
    .filter(tile => supported.includes(tile.key))
    .reduce((sum, tile) => sum + tile.count, 0);
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
