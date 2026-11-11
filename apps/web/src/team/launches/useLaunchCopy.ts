import { useEffect, useRef, useState } from 'react';
import type { LaunchDetail } from '@video-compressor/shared';
import { launchApi, TeamApiError } from '../../api/team';
import { launchMutation } from './analytics';
import { useOptionalToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { navigateTo } from '../../lib/navigation';
import { buildTeamRoute, emptyTeamRouteQuery } from '../routes';
import { formatDayValue } from '../../format';

/** One config-only copy seam for both the list and an open Launch. */
export function useLaunchCopy(teamId: string, onCopied: (value: LaunchDetail) => void) {
  const [busy, setBusy] = useState(false);
  const toasts = useOptionalToasts();
  const { t, language } = useI18n();
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
      const correlation = {
        flowId: pending.args[3],
        launchId: pending.args[1],
        revisionId: pending.args[5] ?? undefined
      };
      pending.receipt ??= await launchMutation(correlation, 'copy_launch', async () => {
        const receipt = await launchApi.copy(...pending.args);
        // The intent names the source; acceptance names the confirmed new record.
        correlation.launchId = receipt.id;
        return receipt;
      });
      if (!mounted.current) return;
      const next = await launchApi.detail(teamId, pending.receipt.id);
      if (!mounted.current) return;
      pending.onCopied(next);
      intent.current = null;
      try {
        const copyPath = buildTeamRoute({
          spaceId: teamId,
          section: 'launches',
          query: { ...emptyTeamRouteQuery(), launchId: next.id, launchTab: 'settings' }
        });
        // The day reads the way the list shows it ("12 лист."), and an action toast
        // already outlasts a plain receipt; a sticky one hung for minutes (1.4.3).
        if (toasts && next.draft.launchDate)
          toasts.push({
            tone: 'success',
            text: t('launchesCopyCreatedForDate', {
              date: formatDayValue(next.draft.launchDate, language === 'uk' ? 'uk-UA' : 'en-US')
            }),
            action: {
              label: t('launchesOpenCopy'),
              run: () => navigateTo(copyPath)
            }
          });
      } catch {
        // A notification cannot invalidate a confirmed copy or invite another one.
      }
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
