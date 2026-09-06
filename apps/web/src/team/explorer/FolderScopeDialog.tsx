import { useEffect, useRef, useState } from 'react';
import type { TeamMaterialSummary } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { FolderSubtree } from '../../api/team';

/**
 * How many files one batch may name. The server bounds the scope array at the
 * same number; without a check here a folder of six hundred came back as
 * "Частина даних некоректна. Перевірте поля" in a window that has no fields.
 */
export const BATCH_SCOPE_LIMIT = 500;

/** The one read the window needs: everything a batch can take under a folder. */
export interface FolderSubtreeClient {
  listFolderSubtree: (teamId: string, rootFolderId: string) => Promise<FolderSubtree>;
}

/**
 * What the batch needs to know about a folder: its name, to say what it is
 * about to work through, and its drive id, to walk it. A row from the list and
 * a node from the tree both answer that.
 */
export interface ProcessableFolder {
  driveFileId: string;
  name: string;
}

/**
 * The first breath of "process this folder": reading the subtree.
 *
 * This used to be a dialog of its own — its own anatomy, its own words, its own
 * engine — sitting beside the space's batch window and disagreeing with it
 * about how many videos needed work. Now it only answers one question, *which
 * files*, under the same title the batch window then wears, so the two read as
 * one flow rather than two products.
 */
/** What the walk is being asked for — the window says so in its own title. */
export type FolderScopeIntent = 'process' | 'compress' | 'previews';

const TITLE_BY_INTENT = {
  process: 'teamBatchTitleFolder',
  compress: 'teamBatchCompressFolderTitle',
  previews: 'teamBatchPreviewsFolderTitle'
} as const;

const EMPTY_BY_INTENT = {
  process: 'teamBatchFolderEmpty',
  compress: 'teamBatchFolderNoVideos',
  previews: 'teamBatchFolderNoLandings'
} as const;

export function FolderScopeDialog({
  teamId,
  folder,
  intent,
  client,
  onResolved,
  onClose
}: {
  teamId: string;
  folder: ProcessableFolder;
  intent: FolderScopeIntent;
  client: FolderSubtreeClient;
  /** Hands the subtree over; the caller decides what to do with it. */
  onResolved: (result: FolderSubtree) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const [empty, setEmpty] = useState<FolderSubtree | null>(null);
  /* The walk has a ceiling, and hitting it means the answer is partial. That is
     said out loud and waits for a press, rather than quietly handing over a set
     that is missing files the person can see in the tree. */
  const [partial, setPartial] = useState<FolderSubtree | null>(null);
  /** The walk hit its ceiling before finding anything it could hand over. */
  const [exhausted, setExhausted] = useState<FolderSubtree | null>(null);
  /** More files than one batch can carry: the count, and what to do instead. */
  const [tooMany, setTooMany] = useState<number | null>(null);

  /* The walk runs once per folder. Held in a ref because the caller passes an
     inline arrow: in the effect's dependencies it would restart the whole
     subtree read on every render of the explorer around it. */
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  useEffect(() => {
    let active = true;
    void client
      .listFolderSubtree(teamId, folder.driveFileId)
      .then(result => {
        if (!active) return;
        const found =
          intent === 'compress'
            ? result.videos.length
            : intent === 'previews'
              ? result.landings.length
              : result.videos.length + result.landings.length;
        /*
         * Five answers, in the order that keeps each one true.
         *
         * A read that stopped at the ceiling has not seen the folder, so it can
         * never say the folder is empty — and with nothing found it has nothing
         * to hand over either: an empty scope is read by the server as the whole
         * space, so that path asks the person to go deeper instead. The size
         * bound comes before the truncation notice, or a cut-short read over six
         * hundred files would offer to process all of them and be refused by the
         * RPC. Only then is there something to hand over.
         */
        if (found === 0 && result.truncated) setExhausted(result);
        else if (found === 0) setEmpty(result);
        // Only the batch has a five-hundred bound: compression and preview
        // refreshes run file by file from this device and are not capped.
        else if (intent === 'process' && found > BATCH_SCOPE_LIMIT) setTooMany(found);
        else if (result.truncated) setPartial(result);
        else resolved.current(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, folder.driveFileId, intent, teamId]);

  return (
    <Modal
      labelledBy="team-batch-scan-title"
      size="md"
      className="team-batch-scan"
      onClose={onClose}
      closeLabel={t('teamClose')}
    >
      <h2 id="team-batch-scan-title">{t(TITLE_BY_INTENT[intent], { name: folder.name })}</h2>
      {tooMany !== null && (
        <p className="team-inline-error" role="alert">
          {/* The count that triggered the refusal, not every file the walk saw:
              compressing six hundred videos beside eighty landings is six
              hundred, and saying 680 answers a question nobody asked. */}
          {t('teamBatchFolderTooMany', { count: tooMany, limit: BATCH_SCOPE_LIMIT })}
        </p>
      )}
      {!failed && !empty && !partial && !exhausted && tooMany === null && (
        /* One read, so one line: the folder-by-folder count it used to tick
           through belonged to a walk that ran from here. */
        <p aria-live="polite">{t('teamBatchScanningFolderOnce')}</p>
      )}
      {exhausted && (
        /* Not a failure — the walk hit a ceiling and is saying how to get past
           it, which is a different kind of message from "this went wrong". */
        <p className="team-inline-notice" role="status">
          {t('teamBatchFolderTooDeep', { count: exhausted.foldersVisited })}
        </p>
      )}
      {partial && (
        <>
          <p className="team-explorer-muted" role="alert">
            {t('teamFolderProcessTruncated', { count: partial.foldersVisited })}
          </p>
          <p>
            {t('teamBatchFolderFound', {
              videos: partial.videos.length,
              landings: partial.landings.length
            })}
          </p>
        </>
      )}
      {empty && (
        <p className="team-explorer-muted">
          {t(EMPTY_BY_INTENT[intent], { count: empty.foldersVisited })}
        </p>
      )}
      {failed && (
        <p className="team-inline-error" role="alert">
          {t('teamFolderPickerFailed')}
        </p>
      )}
      <div className="team-dialog-actions">
        {partial && (
          <Button type="button" variant="primary" onClick={() => resolved.current(partial)}>
            {t('teamBatchFolderContinue')}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('teamClose')}
        </Button>
      </div>
    </Modal>
  );
}

/** The ids a batch runs over: every video and landing the walk found. */
export function scopeIdsOf(result: FolderSubtree): string[] {
  return [...result.videos, ...result.landings].map((item: TeamMaterialSummary) => item.id);
}
