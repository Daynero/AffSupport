import { useEffect, useState } from 'react';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { teamApi, type TeamMaterialSummary, type TeamProcessStartInput } from '../../api/team';
import { startTeamAgentProcess } from '../../api/client';
import { useOptionalAgent } from '../../AgentContext';
import { Modal } from '../../components/Modal';
import { Button, ProgressBar } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import type { FolderPickerClient } from '../catalog/FolderPicker';

/**
 * Batch processing for a folder (owner brief, 2026-08-30): pick a folder,
 * choose "transcribe every video inside" or "refresh every landing preview",
 * or run the whole list at once. Videos that already carry a transcript
 * companion are skipped. Transcriptions run one after another — the agent is
 * one machine — with a visible "n of m" progress.
 */
const TRANSCRIPTION_CONTRACT = 5;

type Batch = {
  label: string;
  done: number;
  total: number;
  current: string;
};

export function FolderProcessDialog({
  teamId,
  folder,
  client,
  onClose,
  onChanged
}: {
  teamId: string;
  folder: TeamMaterialRow;
  client: FolderPickerClient;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const agent = useOptionalAgent();
  const [children, setChildren] = useState<TeamMaterialSummary[] | null>(null);
  const [skippedVideos, setSkippedVideos] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<Batch | null>(null);
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

  const transcribeAll = async () => {
    const contract = agent?.toolContracts?.transcription ?? 0;
    let done = 0;
    for (const video of videos) {
      setBatch({
        label: t('teamFolderProcessTranscribe'),
        done,
        total: videos.length,
        current: video.name
      });
      const stem = video.name.replace(/\.[^.]+$/u, '');
      const input: TeamProcessStartInput = {
        teamId,
        materialId: video.id,
        toolId: 'transcription',
        optionsSummary: {},
        destinationFolderId: folder.driveFileId,
        outputName: `${stem}.txt`,
        conflictMode: 'keep_both',
        idempotencyKey: crypto.randomUUID(),
        agentContractVersion: 1,
        toolContractVersion: contract
      };
      try {
        const result = await teamApi.startProcess(input);
        await startTeamAgentProcess({
          operationId: result.operationId,
          toolId: 'transcription',
          options: {},
          sourceGrant: result.sourceGrant,
          finalizeGrant: result.finalizeGrant
        });
        done += 1;
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        break;
      }
    }
    return done;
  };

  const refreshLandings = async () => {
    let done = 0;
    for (const landing of landings) {
      setBatch({
        label: t('teamFolderProcessLandings'),
        done,
        total: landings.length,
        current: landing.name
      });
      // A landing with no render yet simply has nothing to refresh — the first
      // preview is made automatically on open; that is not a failure.
      await teamApi.regenerateLandingPreview(teamId, landing.id).catch(() => undefined);
      done += 1;
    }
    return done;
  };

  const run = async (what: 'videos' | 'landings' | 'all') => {
    let total = 0;
    if (what !== 'landings') total += await transcribeAll();
    if (what !== 'videos') total += await refreshLandings();
    setBatch(null);
    onChanged();
    if (total > 0) push({ tone: 'success', text: t('teamFolderProcessDone') });
    onClose();
  };

  const busy = batch !== null;
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
                  onClick={() => void run('videos')}
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
                  onClick={() => void run('landings')}
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
                  onClick={() => void run('all')}
                >
                  {t('teamFolderProcessAll')}
                </Button>
              </li>
            </ul>
          )}
        </>
      )}
      {batch && (
        <div className="team-folder-process-progress" aria-live="polite">
          <p>
            {t('teamFolderProcessRunning', {
              done: batch.done + 1,
              total: batch.total,
              name: batch.current
            })}
          </p>
          <ProgressBar
            value={batch.total === 0 ? 0 : (batch.done / batch.total) * 100}
            active
            label={batch.label}
          />
        </div>
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
