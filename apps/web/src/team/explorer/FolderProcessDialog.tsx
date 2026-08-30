import { useEffect, useState } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { teamApi, type TeamMaterialSummary } from '../../api/team';
import { useOptionalAgent } from '../../AgentContext';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { FolderPickerClient } from '../catalog/FolderPicker';

/**
 * Batch processing for a folder (owner brief, 2026-08-30): pick a folder,
 * choose "transcribe every video inside" or "refresh every landing preview",
 * or run the whole list at once. Videos that already carry a transcript
 * companion are skipped. Transcriptions run one after another — the agent is
 * one machine — with a visible "n of m" progress.
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
  onRun
}: {
  teamId: string;
  folder: TeamMaterialRow;
  client: FolderPickerClient;
  onClose: () => void;
  /** The shell runs the batch in the background; the dialog only chooses. */
  onRun: (plan: FolderBatchPlan) => void;
}) {
  const { t } = useI18n();
  const agent = useOptionalAgent();
  const [children, setChildren] = useState<TeamMaterialSummary[] | null>(null);
  const [skippedVideos, setSkippedVideos] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState(false);

  const transcriptionReady =
    agent?.teamWorkspaceAvailable === true &&
    (agent?.toolContracts?.transcription ?? 0) >= TRANSCRIPTION_CONTRACT;

  useEffect(() => {
    let active = true;
    void client
      .listMaterials(teamId, folder.driveFileId)
      .then(async items => {
        if (!active) return;
        setChildren(items);
        // Which videos already have their transcript, so they can be skipped.
        const videos = items.filter(item => item.kind === 'file' && item.category === 'video');
        const done = new Set<string>();
        for (const video of videos) {
          const companion = await teamApi.getTranscriptCompanion(teamId, video.id).catch(() => null);
          if (companion?.hasText) done.add(video.id);
          if (!active) return;
        }
        setSkippedVideos(done);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, folder.driveFileId, teamId]);

  const videos = (children ?? []).filter(
    item => item.kind === 'file' && item.category === 'video' && !skippedVideos.has(item.id)
  );
  const landings = (children ?? []).filter(
    item => item.kind === 'file' && item.category === 'landing'
  );

  const run = (what: 'videos' | 'landings' | 'all') => {
    onRun({ folder, what, videos, landings });
    onClose();
  };

  const busy = false;
  const loading = children === null && !failed;

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
      {loading && <p className="ui-skeleton-label">{t('teamFolderPickerLoading')}</p>}
      {failed && (
        <p className="team-inline-error" role="alert">
          {t('teamFolderPickerFailed')}
        </p>
      )}
      {children !== null && !busy && (
        <>
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
