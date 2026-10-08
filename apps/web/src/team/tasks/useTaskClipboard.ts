import { useEffect, useRef } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';

const PREFIX = 'SOTY_TASKS_V1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function editing(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'textarea, [contenteditable="true"], [role="textbox"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"])'
      )
    )
  );
}

export interface TaskCopyClient {
  copyTasks?: (input: { teamId: string; taskIds: string[] }) => Promise<string[]>;
}

/** Native copy/paste events support Cmd on macOS and Ctrl on Windows without
 * clipboard read permissions or intercepting editing inside a field. */
export function useTaskClipboard({
  teamId,
  selected,
  canEdit,
  client,
  onPasted
}: {
  teamId: string;
  selected: readonly TeamTaskSummary[];
  canEdit: boolean;
  client: TaskCopyClient;
  onPasted: (ids: string[]) => Promise<void> | void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const pasting = useRef(false);
  useEffect(() => {
    if (!canEdit || !client.copyTasks) return;
    const blocked = (event: ClipboardEvent) =>
      editing(event.target) ||
      Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
    const copy = (event: ClipboardEvent) => {
      if (blocked(event) || !event.clipboardData || selected.length === 0) return;
      if (window.getSelection()?.toString()) return;
      event.clipboardData.setData(
        'text/plain',
        PREFIX +
          JSON.stringify({
            teamId,
            taskIds: selected.map(task => task.id)
          })
      );
      event.preventDefault();
      push({ tone: 'success', text: t('teamTasksCopied', { count: selected.length }) });
    };
    const paste = (event: ClipboardEvent) => {
      if (blocked(event)) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!text.startsWith(PREFIX)) return;
      let payload: { teamId: string; taskIds: string[] };
      try {
        const parsed = JSON.parse(text.slice(PREFIX.length));
        if (
          !parsed ||
          typeof parsed.teamId !== 'string' ||
          !Array.isArray(parsed.taskIds) ||
          parsed.taskIds.length < 1 ||
          parsed.taskIds.length > 100 ||
          !parsed.taskIds.every((id: unknown) => typeof id === 'string' && UUID.test(id))
        )
          return;
        payload = parsed;
      } catch {
        return;
      }
      event.preventDefault();
      if (payload.teamId !== teamId) {
        push({ tone: 'error', text: t('teamTasksPasteSameSpace') });
        return;
      }
      if (pasting.current) return;
      pasting.current = true;
      void client.copyTasks!({ teamId, taskIds: payload.taskIds })
        .then(async ids => {
          await onPasted(ids);
          push({ tone: 'success', text: t('teamTasksPasted', { count: ids.length }) });
        })
        .catch(cause => push({ tone: 'error', text: teamErrorMessageFor(cause, t) }))
        .finally(() => {
          pasting.current = false;
        });
    };
    document.addEventListener('copy', copy);
    document.addEventListener('paste', paste);
    return () => {
      document.removeEventListener('copy', copy);
      document.removeEventListener('paste', paste);
    };
  }, [canEdit, client, onPasted, push, selected, t, teamId]);
}
