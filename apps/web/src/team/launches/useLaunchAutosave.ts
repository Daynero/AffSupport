import { useEffect, useRef } from 'react';
import type { LaunchDraft, LaunchSourceSnapshot } from '@video-compressor/shared';

export interface LaunchAutosaveRequest {
  teamId: string;
  id: string | null;
  version: string | null;
  requestKey: string;
  config: LaunchDraft;
  sources: LaunchSourceSnapshot | null;
}
/** One protected write at a time. Unknown replies retry the identical intent. */
export function useLaunchAutosave(input: {
  enabled: boolean;
  dirty: boolean;
  teamId: string;
  id: string | null;
  version: string | null;
  config: LaunchDraft;
  sources: LaunchSourceSnapshot | null;
  save: (request: LaunchAutosaveRequest) => Promise<{ id: string; version: string }>;
  onSaved: (request: LaunchAutosaveRequest, result: { id: string; version: string }) => void;
  onSaving: (saving: boolean) => void;
  onError: (error: unknown) => void;
  retryable: (error: unknown) => boolean;
  canRecoverOnEdit?: (error: unknown) => boolean;
}) {
  const latest = useRef(input);
  latest.current = input;
  const active = useRef(false);
  const blocked = useRef(false);
  const blockedVersion = useRef<string | null | undefined>(undefined);
  const mounted = useRef(true);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);
  useEffect(() => {
    if (blocked.current && input.version !== blockedVersion.current) blocked.current = false;
    if (!input.enabled || active.current || blocked.current || !input.dirty) return;
    const timer = setTimeout(
      () => {
        if (!mounted.current || !latest.current.enabled || active.current) return;
        const current = latest.current;
        const request: LaunchAutosaveRequest = {
          teamId: current.teamId,
          id: current.id,
          version: current.version,
          requestKey: crypto.randomUUID(),
          config: current.config,
          sources: current.sources
        };
        active.current = true;
        current.onSaving(true);
        let attempts = 0;
        const attempt = async () => {
          if (!mounted.current) return;
          try {
            const result = await latest.current.save(request);
            if (!mounted.current) return;
            // Keep actions fenced until the acknowledged version reaches the editor.
            latest.current.onSaved(request, result);
            active.current = false;
            latest.current.onSaving(false);
          } catch (error) {
            if (!mounted.current) return;
            latest.current.onError(error);
            if (latest.current.retryable(error)) {
              const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
              retryTimer.current = setTimeout(() => void attempt(), delay);
            } else {
              blocked.current = !latest.current.canRecoverOnEdit?.(error);
              blockedVersion.current = request.version;
              active.current = false;
              latest.current.onSaving(false);
            }
          }
        };
        void attempt();
      },
      input.id ? 500 : 0
    );
    return () => clearTimeout(timer);
  }, [input.enabled, input.dirty, input.id, input.version, input.config, input.sources]);
}
