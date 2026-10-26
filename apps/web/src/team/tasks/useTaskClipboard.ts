import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TeamTaskSummary } from '@video-compressor/shared';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { teamErrorMessageFor } from '../errors';

import {
  beginWorkspaceOperation,
  type WorkspaceOperationFlow
} from '../workspace/operationAnalytics';

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
  copyTasks?: (input: {
    teamId: string;
    taskIds: string[];
    idempotencyKey?: string;
  }) => Promise<string[]>;
}

/** Native copy/paste events support Cmd on macOS and Ctrl on Windows without
 * clipboard read permissions or intercepting editing inside a field. */
export function useTaskClipboard({
  teamId,
  selected,
  canEdit,
  client,
  onPasted,
  anchor,
  onSettled
}: {
  /** An element inside the task board: while the board is hidden (another
      section is showing) copy and paste are not the board's to answer. */
  anchor?: RefObject<HTMLElement | null>;
  teamId: string;
  selected: readonly TeamTaskSummary[];
  canEdit: boolean;
  client: TaskCopyClient;
  onPasted: (ids: string[]) => Promise<void> | void;
  onSettled?: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [delivered, setDelivered] = useState<WorkspaceOperationFlow | null>(null);
  useEffect(() => {
    if (document.visibilityState === 'visible') delivered?.visible();
  }, [delivered]);
  const pasting = useRef(false);
  const [copying, setCopying] = useState(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const attemptFor = useCallback(
    (signature: string) => {
      const storageKey = `soty.task-copy.${teamId}`;
      if (!pending.current) {
        try {
          const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
          if (
            stored &&
            typeof stored === 'object' &&
            'signature' in stored &&
            'key' in stored &&
            typeof stored.signature === 'string' &&
            typeof stored.key === 'string' &&
            UUID.test(stored.key)
          ) {
            pending.current = { signature: stored.signature, key: stored.key };
          }
        } catch {
          /* An unavailable intent store never becomes evidence of server success. */
        }
      }
      if (pending.current?.signature !== signature)
        pending.current = { signature, key: crypto.randomUUID() };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(pending.current));
      } catch {
        /* Keep the in-memory key. */
      }
      return pending.current.key;
    },
    [teamId]
  );
  // Card shortcut and native paste share one idempotent, diagnosed operation.
  const duplicate = useCallback(
    (taskIds: string[]) => {
      if (!canEdit || !client.copyTasks || pasting.current || taskIds.length === 0) return;
      pasting.current = true;
      setCopying(true);
      const idempotencyKey = attemptFor(JSON.stringify(taskIds));
      const flow = beginWorkspaceOperation('task_copy', idempotencyKey, taskIds.length);
      void client.copyTasks!({ teamId, taskIds: taskIds, idempotencyKey })
        .then(async ids => {
          flow.stage('confirmed');
          await onPasted(ids);
          pending.current = null;
          try {
            sessionStorage.removeItem(`soty.task-copy.${teamId}`);
          } catch {
            /* Retrying a completed receipt remains safe. */
          }
          push({ tone: 'success', text: t('teamTasksPasted', { count: ids.length }) });
          setDelivered(flow);
        })
        .catch(cause => {
          flow.fail(cause);
          push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        })
        .finally(() => {
          pasting.current = false;
          setCopying(false);
          onSettled?.();
        });
    },
    [attemptFor, canEdit, client, onPasted, onSettled, push, t, teamId]
  );
  useEffect(() => {
    if (!canEdit || !client.copyTasks) return;
    const blocked = (event: ClipboardEvent) =>
      Boolean(anchor && (!anchor.current || anchor.current.closest('[hidden]'))) ||
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
      duplicate(payload.taskIds);
    };
    document.addEventListener('copy', copy);
    document.addEventListener('paste', paste);
    return () => {
      document.removeEventListener('copy', copy);
      document.removeEventListener('paste', paste);
    };
  }, [anchor, canEdit, client, duplicate, push, selected, t, teamId]);
  return { duplicate, copying };
}
