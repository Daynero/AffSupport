import { useEffect, useRef, useState } from 'react';
import type { LaunchDetail } from '@video-compressor/shared';
import { launchApi, TeamApiError } from '../../api/team';
import { launchMutation } from './analytics';

/** One config-only copy seam for both the list and an open Launch. */
export function useLaunchCopy(teamId: string, onCopied: (value: LaunchDetail) => void) {
  const [busy, setBusy] = useState(false);
  const [, refresh] = useState(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const intent = useRef<{
    args: Parameters<typeof launchApi.copy>;
    receipt: Awaited<ReturnType<typeof launchApi.copy>> | null;
    onCopied: (value: LaunchDetail) => void;
  } | null>(null);
  const handler = useRef(onCopied);
  handler.current = onCopied;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const copy = async (source: { id: string; version: string; revisionId?: string | null }) => {
    if (inFlight.current) return;
    if (intent.current && intent.current.args[1] !== source.id)
      throw new TeamApiError('LAUNCH_BUSY', false);
    intent.current ??= {
      args: [
        teamId,
        source.id,
        source.version,
        crypto.randomUUID(),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        source.revisionId ?? null
      ],
      receipt: null,
      onCopied: handler.current
    };
    const pending = intent.current;
    inFlight.current = true;
    setBusy(true);
    try {
      pending.receipt ??= await launchMutation(
        {
          flowId: pending.args[3],
          launchId: pending.args[1],
          revisionId: pending.args[5] ?? undefined
        },
        'copy_launch',
        () => launchApi.copy(...pending.args)
      );
      if (!mounted.current) return;
      const next = await launchApi.detail(teamId, pending.receipt.id);
      if (!mounted.current) return;
      pending.onCopied(next);
      intent.current = null;
    } catch (error) {
      // A confirmed copy is never repeated just because the subsequent read failed.
      if (
        !pending.receipt &&
        error instanceof TeamApiError &&
        [
          'LAUNCH_VERSION_CONFLICT',
          'LAUNCH_BUSY',
          'SOURCE_CHANGED',
          'INVALID_INPUT',
          'PERMISSION_DENIED',
          'NOT_FOUND',
          'SPACE_BLOCKED'
        ].includes(error.code)
      )
        intent.current = null;
      throw error;
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        refresh(value => value + 1);
      }
    }
  };
  return {
    copy,
    busy,
    sourceId: intent.current?.args[1] ?? null,
    hasUnresolvedRequest: intent.current !== null
  };
}
