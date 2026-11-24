import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';

/**
 * Where a settings panel says what became of the last change (070, T052; FR-025).
 *
 * The account page has done this since 024: "Saving…", "Saved" or "Could not save" on the
 * panel's title line, where the compressor keeps its summary, and nothing else to look for.
 * The space's panels each answered differently — one with a toast, one with nothing at all
 * (`TeamPreferencesSection` dropped a failed write on the floor and showed the value as if it
 * had been kept). This is the account page's answer, shared: one word, in one place, and the
 * failure read out as an alert.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

export function useSaveState() {
  const [state, setState] = useState<SaveState>('idle');
  const mounted = useRef(true);
  /** The write a later one replaced says nothing: only the last press's outcome is shown. */
  const latest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * Runs one write and tracks it. Resolves `true` when it was kept; a failure is reported
   * here and not rethrown, so a caller decides only what happens to the value it holds.
   */
  const track = useCallback(async (write: () => Promise<unknown>): Promise<boolean> => {
    const ticket = ++latest.current;
    setState('saving');
    try {
      await write();
      if (mounted.current && ticket === latest.current) setState('saved');
      return true;
    } catch {
      if (mounted.current && ticket === latest.current) setState('failed');
      return false;
    }
  }, []);
  return { state, setState, track };
}

export function SaveStateWord({ state }: { state: SaveState }) {
  const { t } = useI18n();
  if (state === 'idle') return null;
  const failed = state === 'failed';
  return (
    <span
      className={`settings-save-state${failed ? ' is-failed' : ''}`}
      role={failed ? 'alert' : 'status'}
      data-save-state={state}
    >
      {t(state === 'saving' ? 'saving' : state === 'saved' ? 'accountSaved' : 'accountSaveFailed')}
    </span>
  );
}
