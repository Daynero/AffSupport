import { useCallback, useRef, useState } from 'react';
import { cleanDeliverySupported } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { useOptionalAgent } from '../../AgentContext';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { downloadMaterial, type DownloadMetadata } from '../materials/download-material';
import { useOptionalSpaceAgentQueue } from '../processing/AgentQueueProvider';
import type { AgentQueueItem } from './useAgentQueue';

/** What a selection needs to say about a thing to download it. */
export interface DownloadableSelection {
  id: string;
  teamId: string;
  name: string;
  kind: string;
  parentFolderId?: string | null;
}

/**
 * Downloading a selection (073, owner 2026-11-25: «виділяю багато креативів — масово скачати»).
 *
 * With Soty on the computer every file goes through the space's queue: one corner panel with
 * the file in flight, a bar, pause and stop, as compressing a selection already does — and the
 * files land together in `Downloads/Soty/<folder>` (or «Обрані» from search results) instead of
 * a folder picker per batch. Clean unless the person picked the "with metadata" act.
 *
 * Without Soty the browser takes them one after another — never fifty tabs, and each one saved
 * from a blob (see `browser-download.ts`). The browser path takes files up to 32 MiB; the
 * larger ones are counted and the closing toast says they need Soty, with the way to install it.
 *
 * Folders are not walked: a checked folder is skipped and said so. Walking it means listing
 * Drive recursively behind a click, and a "download" that quietly turns into thousands of files
 * is the surprise this bar exists to prevent; opening the folder and selecting is one step.
 */
export function useSelectionDownload({
  folderName,
  onNeedsApp
}: {
  /** The folder open now, which names the batch's folder in Downloads/Soty. */
  folderName: string | null;
  /** Opens the way to install or connect Soty. */
  onNeedsApp?: () => void;
}) {
  const { t } = useI18n();
  const { push, update } = useToasts();
  const agent = useOptionalAgent();
  const space = useOptionalSpaceAgentQueue();
  const [browserBusy, setBrowserBusy] = useState(false);
  const running = useRef(false);

  const download = useCallback(
    async (items: readonly DownloadableSelection[], metadata: DownloadMetadata) => {
      const files = items.filter(item => item.kind !== 'folder');
      const folders = items.length - files.length;
      if (folders > 0) {
        push({ tone: 'info', text: t('teamSelectionDownloadFoldersSkipped', { count: folders }) });
      }
      if (files.length === 0) return;
      const appReady =
        agent?.teamWorkspaceAvailability === 'ready' &&
        (metadata === 'original' || cleanDeliverySupported(agent.toolContracts ?? {}));
      if (appReady && space?.queue) {
        const saveInto = folderName ?? t('teamSelectionDownloadFolderFallback');
        const jobs: AgentQueueItem[] = files.map(item => ({
          id: item.id,
          name: item.name,
          folderId: item.parentFolderId ?? null,
          tool: 'download',
          outputName: item.name,
          deliver: { saveInto, metadata }
        }));
        space.queue.enqueue(jobs);
        return;
      }
      if (running.current) return;
      running.current = true;
      setBrowserBusy(true);
      const toast = push({
        tone: 'info',
        sticky: true,
        text: t('teamSelectionDownloadProgress', { done: 0, total: files.length }),
        progress: 0
      });
      let saved = 0;
      let needsApp = 0;
      let failed = 0;
      let lastError: unknown = null;
      try {
        for (const [index, item] of files.entries()) {
          try {
            await downloadMaterial({
              teamId: item.teamId,
              materialId: item.id,
              fileName: item.name,
              metadata,
              requestDownload: (team, id, consumer) => teamApi.requestDownload(team, id, consumer),
              // Without a ready app nothing is handed to it: the file is counted instead.
              downloadWithAgent: () => Promise.reject(new Error('AGENT_REQUIRED')),
              takeOverAgentPath: () => Promise.reject(new Error('AGENT_REQUIRED'))
            });
            saved += 1;
          } catch (cause) {
            const code = cause instanceof Error ? cause.message : '';
            if (code === 'AGENT_REQUIRED' || code === 'AGENT_UPDATE_REQUIRED') needsApp += 1;
            else {
              failed += 1;
              lastError = cause;
            }
          }
          update(toast, {
            text: t('teamSelectionDownloadProgress', { done: index + 1, total: files.length }),
            progress: Math.round(((index + 1) / files.length) * 100)
          });
        }
      } finally {
        running.current = false;
        setBrowserBusy(false);
      }
      const needsAppText =
        needsApp > 0 ? t('teamSelectionDownloadNeedsApp', { count: needsApp }) : null;
      update(toast, {
        tone: failed > 0 || needsApp > 0 ? 'warning' : 'success',
        sticky: needsApp > 0,
        progress: undefined,
        text: [
          saved > 0 ? t('teamSelectionDownloadSaved', { count: saved }) : null,
          needsAppText,
          failed > 0 && lastError ? teamErrorMessageFor(lastError, t) : null
        ]
          .filter(Boolean)
          .join(' '),
        ...(needsApp > 0 && onNeedsApp
          ? { action: { label: t('teamSelectionDownloadGetApp'), run: onNeedsApp } }
          : {})
      });
    },
    [agent, folderName, onNeedsApp, push, space, t, update]
  );

  return { download, browserBusy };
}
