import { useEffect, useState } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { teamApi, type TeamMaterialSummary } from '../../api/team';
import { useOptionalAgent } from '../../AgentContext';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { FolderPickerClient } from '../catalog/FolderPicker';
import { scanFolderTree, type FolderScanResult } from './folderScan';

/**
 * Batch processing for a folder (owner brief, 2026-08-30): pick a folder,
 * choose "transcribe every video inside" or "refresh every landing preview",
 * or run the whole list at once. Videos that already carry a transcript
 * companion are skipped. Transcriptions run one after another — the agent is
 * one machine — with a visible "n of m" progress.
 *
 * "Inside" means the whole subtree (owner, 2026-09-02). Reading one level made
 * the command useless on the shape libraries actually have — a folder of
 * folders answered "nothing inside needs processing".
 */
const TRANSCRIPTION_CONTRACT = 5;

export interface FolderBatchPlan {
  folder: TeamMaterialRow;
  what: 'videos' | 'landings' | 'all';
  videos: TeamMaterialSummary[];
  landings: TeamMaterialSummary[];
}

export function FolderProcessDialog({
  teamId,
  folder,
  client,
  onClose,
  onRun,
  onCompressAll
}: {
  teamId: string;
  folder: TeamMaterialRow;
  client: FolderPickerClient;
  onClose: () => void;
  /** The shell runs the batch in the background; the dialog only chooses. */
  onRun: (plan: FolderBatchPlan) => void;
  /** Opens the compact compressor over every video inside (013 B2). */
  onCompressAll?: (videos: TeamMaterialSummary[]) => void;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const [scan, setScan] = useState<FolderScanResult | null>(null);
  const [scanned, setScanned] = useState(0);
  const [skippedVideos, setSkippedVideos] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  const transcriptionReady =
    agent?.teamWorkspaceAvailable === true &&
    (agent?.toolContracts?.transcription ?? 0) >= TRANSCRIPTION_CONTRACT;

  useEffect(() => {
    let active = true;
    void scanFolderTree({
      teamId,
      client,
      rootFolderId: folder.driveFileId,
      isCancelled: () => !active,
      onProgress: visited => {
        if (active) setScanned(visited);
      }
    })
      .then(async result => {
        if (!active) return;
        setScan(result);
        // Which videos already have their transcript, so they can be skipped.
        const done = await videosWithTranscripts(teamId, result.videos, () => !active);
        if (active) setSkippedVideos(done);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, folder.driveFileId, teamId]);

  const allVideos = scan?.videos ?? [];
  const videos = allVideos.filter(item => !skippedVideos.has(item.id));
  const landings = scan?.landings ?? [];

  const run = (what: 'videos' | 'landings' | 'all') => {
    onRun({ folder, what, videos, landings });
    onClose();
  };

  const busy = false;
  const loading = scan === null && !failed;

  return (
    <Modal
      labelledBy="team-folder-process-title"
      size="md"
      className="team-folder-process"
      onClose={busy ? undefined : onClose}
    >
      <h3 id="team-folder-process-title">
        {t('teamFolderProcessTitle', { name: folder.name })}
      </h3>
      {loading && (
        <p className="ui-skeleton-label" aria-live="polite">
          {t('teamFolderProcessScanning', { count: scanned })}
        </p>
      )}
      {failed && (
        <p className="team-inline-error" role="alert">
          {t('teamFolderPickerFailed')}
        </p>
      )}
      {scan !== null && !busy && (
        <>
          <p className="team-explorer-muted team-folder-process-scope">
            {t('teamFolderProcessSubfolders', { count: scan.foldersVisited })}
          </p>
          {videos.length === 0 && landings.length === 0 ? (
            <p className="team-explorer-muted">{t('teamFolderProcessEmpty')}</p>
          ) : (
            <ul className="team-folder-process-actions">
              <li>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={videos.length === 0 || !transcriptionReady}
                  onClick={() => run('videos')}
                >
                  {t('teamFolderProcessTranscribe')}
                </Button>
                <span className="team-explorer-muted">
                  {t('teamFolderProcessVideosCount', {
                    count: videos.length,
                    skipped: skippedVideos.size
                  })}
                </span>
              </li>
              {onCompressAll && (
                <li>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={allVideos.length === 0}
                    onClick={() => onCompressAll(allVideos)}
                  >
                    {t('teamFolderProcessCompress')}
                  </Button>
                  <span className="team-explorer-muted">
                    {t('teamFolderProcessCompressCount', { count: allVideos.length })}
                  </span>
                </li>
              )}
              <li>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={landings.length === 0}
                  onClick={() => run('landings')}
                >
                  {t('teamFolderProcessLandings')}
                </Button>
                <span className="team-explorer-muted">
                  {t('teamFolderProcessLandingsCount', { count: landings.length })}
                </span>
              </li>
              <li>
                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    (videos.length === 0 || !transcriptionReady) && landings.length === 0
                  }
                  onClick={() => run('all')}
                >
                  {t('teamFolderProcessAll')}
                </Button>
              </li>
            </ul>
          )}
          {scan.truncated && (
            <p className="team-explorer-muted">
              {t('teamFolderProcessTruncated', { count: scan.foldersVisited })}
            </p>
          )}
        </>
      )}
      {!busy && (
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/**
 * The videos that already have a transcript, asked a few at a time.
 *
 * One question per video, and a subtree can hold hundreds; sequential was fine
 * for a single folder and is a visible wait for a library.
 */
async function videosWithTranscripts(
  teamId: string,
  videos: TeamMaterialSummary[],
  cancelled: () => boolean
): Promise<Set<string>> {
  const done = new Set<string>();
  const queue = [...videos];
  const ask = async () => {
    for (;;) {
      const video = queue.shift();
      if (!video || cancelled()) return;
      const companion = await teamApi.getTranscriptCompanion(teamId, video.id).catch(() => null);
      if (companion?.hasText) done.add(video.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, videos.length) }, ask));
  return done;
}
