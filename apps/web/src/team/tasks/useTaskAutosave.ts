import { useCallback, useEffect, useRef, useState } from 'react';
import type { TeamTaskPatch, TeamTaskSummary } from '@video-compressor/shared';
import { teamErrorCodeOf } from '../errors';
import { useCoalescedWrite } from './useCoalescedWrite';

/**
 * A task that saves itself (024).
 *
 * The editor used to hold every field until a Save button was pressed, which
 * cost it a draft in sessionStorage to survive a discarded tab, a dirty flag,
 * an "unsaved changes" dialog in front of the close button, and a staged
 * attachment that existed on the task in the reader's eyes and nowhere else.
 * Four mechanisms and one modal, all of them there to protect work that the
 * product could simply have kept.
 *
 * Meanwhile status and progress in the same dialog already saved on change,
 * so the editor was teaching two contradictory rules at once: this control
 * commits, that one waits.
 *
 * Now everything commits.
 *
 * ## What "soon" means
 *
 * A picker, a slider or a status commits at once — the gesture is the
 * decision. Typing does not: `saveSoon` waits for a pause, and `flush` sends
 * whatever is pending immediately, which is what a blur and an unmount do. So
 * a sentence is one write, not forty, and leaving a field never loses the last
 * word typed in it.
 *
 * ## Conflicts are a choice, not a snap-back
 *
 * Every write still carries `expectedUpdatedAt`, so a teammate's edit cannot
 * be overwritten silently. When the server refuses with `SOURCE_CHANGED` the
 * write is held, not discarded: the caller is told, shows the newer task, and
 * the reader decides whether to take it or send theirs anyway. Snapping the
 * field back to the server's value — the usual answer — throws away the thing
 * the person was in the middle of writing.
 */

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'conflict';

export interface TaskAutosave {
  /** Commit now: a choice made by a gesture. */
  save: (patch: TeamTaskPatch) => void;
  /** Commit after a pause: a field being typed into. */
  saveSoon: (patch: TeamTaskPatch) => void;
  /** Send anything pending at once — a blur, a close, an unmount. */
  flush: () => void;
  state: AutosaveState;
  /** The task as the server has it, when a write was refused as stale. */
  conflict: TeamTaskSummary | null;
  /** Send the refused write anyway, over the newer version. */
  overwrite: () => void;
  /** Drop the refused write and take the server's task. */
  takeNewer: () => void;
}

const TYPING_PAUSE_MS = 700;

export function useTaskAutosave({
  write,
  read,
  onSaved
}: {
  /** The one call that writes; it is given the version to expect. */
  write: (patch: TeamTaskPatch) => Promise<TeamTaskSummary>;
  /** Re-read the task, to show what the other person put there. */
  read: () => Promise<TeamTaskSummary | null>;
  onSaved: (task: TeamTaskSummary) => void;
}): TaskAutosave {
  const [state, setState] = useState<AutosaveState>('idle');
  const [conflict, setConflict] = useState<TeamTaskSummary | null>(null);
  const refused = useRef<TeamTaskPatch | null>(null);
  const pending = useRef<TeamTaskPatch | null>(null);
  const timer = useRef<number | null>(null);
  const savedFor = useRef<number | null>(null);

  const writeRef = useRef(write);
  writeRef.current = write;
  const readRef = useRef(read);
  readRef.current = read;
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  const writer = useCoalescedWrite<TeamTaskPatch>({
    merge: (held, next) => ({ ...held, ...next }),
    write: async patch => {
      const updated = await writeRef.current(patch);
      savedRef.current(updated);
      setState('saved');
      // "Saved" is a receipt, not a status: it says so and then gets out of
      // the way, because a permanent badge is something to read every time.
      if (savedFor.current !== null) window.clearTimeout(savedFor.current);
      savedFor.current = window.setTimeout(() => setState('idle'), 2_500);
    },
    onError: async error => {
      if (teamErrorCodeOf(error) !== 'SOURCE_CHANGED') {
        setState('failed');
        return;
      }
      setState('conflict');
      const newer = await readRef.current().catch(() => null);
      setConflict(newer);
    }
  });

  const send = useCallback(
    (patch: TeamTaskPatch) => {
      refused.current = { ...refused.current, ...patch };
      setState('saving');
      writer.send(patch);
    },
    [writer]
  );

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = null;
    if (patch) send(patch);
  }, [send]);

  const save = useCallback(
    (patch: TeamTaskPatch) => {
      // Anything half-typed goes with it, so the two cannot arrive out of order.
      const held = pending.current;
      pending.current = null;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      send(held ? { ...held, ...patch } : patch);
    },
    [send]
  );

  const saveSoon = useCallback(
    (patch: TeamTaskPatch) => {
      pending.current = { ...pending.current, ...patch };
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const held = pending.current;
        pending.current = null;
        if (held) send(held);
      }, TYPING_PAUSE_MS);
    },
    [send]
  );

  // A field left with a word in it is a word the person meant to keep.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (savedFor.current !== null) window.clearTimeout(savedFor.current);
      const held = pending.current;
      if (held) void writeRef.current(held).catch(() => undefined);
    },
    []
  );

  const overwrite = useCallback(() => {
    const patch = refused.current;
    setConflict(null);
    if (patch) send(patch);
  }, [send]);

  const takeNewer = useCallback(() => {
    const newer = conflict;
    refused.current = null;
    setConflict(null);
    setState('idle');
    if (newer) savedRef.current(newer);
  }, [conflict]);

  return { save, saveSoon, flush, state, conflict, overwrite, takeNewer };
}
