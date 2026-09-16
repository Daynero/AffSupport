import { useCallback, useRef } from 'react';
import type { TeamPermissions } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';
import { copyMaterialWithTail, moveMaterialWithTail, type TailClient } from '../materials/tail';

/**
 * Copy, cut and paste in the explorer (024, FR-095).
 *
 * A clipboard is a clipboard: it holds what was taken, it knows whether the
 * originals are to stay, and it pastes into whatever folder is open. None of
 * that has anything to do with the upload zone, the job queue, the tag writer
 * or the arrow keys, all of which it was sitting between.
 *
 * Held in a ref rather than state on purpose: nothing on screen changes when
 * you press ⌘C, and re-rendering a folder of five hundred rows to remember
 * four ids would be the most expensive thing a copy ever did.
 */

export interface ExplorerClipboardItem {
  id: string;
  name: string;
  kind: string;
  /** Category as well as kind: what travels with a file depends on it. */
  category: string | null;
}

export interface ExplorerClipboard {
  /** Take these, leaving the originals or not. */
  take: (mode: 'copy' | 'cut', items: ExplorerClipboardItem[]) => void;
  /** Whether there is anything to paste. */
  has: () => boolean;
  paste: () => Promise<void>;
}

export function useExplorerClipboard({
  teamId,
  currentFolderId,
  permissions,
  tailClient,
  onChanged,
  clearSelection
}: {
  teamId: string;
  currentFolderId: string | null;
  permissions: TeamPermissions | null;
  tailClient: TailClient;
  onChanged: () => void;
  clearSelection: () => void;
}): ExplorerClipboard {
  const { t } = useI18n();
  const { push, update, dismiss } = useToasts();
  const changed = onChanged;
  // Cmd/Ctrl+C/X/V: what was copied or cut, held until the next paste. Files
  // from any folder — paste lands them in the folder currently open.
  const clipboard = useRef<{
    mode: 'copy' | 'cut';
    items: ExplorerClipboardItem[];
  } | null>(null);

  const paste = useCallback(async () => {
    const clip = clipboard.current;
    if (!clip) return;
    if (clip.mode === 'copy' && !permissions?.upload) return;
    if (clip.mode === 'cut' && !permissions?.edit) return;
    // The Drive API cannot copy folders; a cut (move) handles them fine.
    const items =
      clip.mode === 'copy' ? clip.items.filter(item => item.kind !== 'folder') : clip.items;
    const skipped = clip.items.length - items.length;
    if (items.length === 0) {
      push({ tone: 'error', text: t('teamExplorerPasteFoldersOnly') });
      return;
    }
    let done = 0;
    // Copying a file is a Drive-side operation per file, and each one brings its
    // transcript with it — twenty pasted videos is forty round trips. A single
    // line that counts is the difference between "nothing is happening" and
    // "this is going to take a moment".
    const progress = push({
      tone: 'info',
      sticky: true,
      progress: 0,
      text: t(clip.mode === 'copy' ? 'teamExplorerPastingCopy' : 'teamExplorerPastingMove', {
        done: 0,
        total: items.length
      })
    });
    for (const item of items) {
      try {
        const material = { id: item.id, name: item.name, category: item.category };
        if (clip.mode === 'copy') {
          await copyMaterialWithTail({
            teamId,
            material,
            destinationFolderId: currentFolderId ?? null,
            client: tailClient
          });
        } else {
          await moveMaterialWithTail({
            teamId,
            material,
            destinationFolderId: currentFolderId ?? null,
            conflictMode: 'keep_both',
            client: tailClient
          });
        }
        done += 1;
        update(progress, {
          progress: (done / items.length) * 100,
          text: t(clip.mode === 'copy' ? 'teamExplorerPastingCopy' : 'teamExplorerPastingMove', {
            done,
            total: items.length
          })
        });
      } catch (cause) {
        push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        break;
      }
    }
    if (clip.mode === 'cut') clipboard.current = null;
    if (done > 0) {
      changed();
      clearSelection();
      update(progress, {
        tone: 'success',
        sticky: false,
        progress: undefined,
        text: t('teamExplorerPastedCount', { count: done })
      });
      if (skipped > 0) {
        push({ tone: 'error', text: t('teamExplorerPasteFoldersSkipped', { count: skipped }) });
      }
    } else {
      dismiss(progress);
    }
  }, [
    changed,
    clearSelection,
    currentFolderId,
    dismiss,
    permissions,
    push,
    t,
    tailClient,
    teamId,
    update
  ]);

  return {
    take: (mode, items) => {
      clipboard.current = { mode, items };
    },
    has: () => clipboard.current !== null,
    paste
  };
}
