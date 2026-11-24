import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { WorkspaceChip } from './WorkspaceChip';
import { useRealtimeGrace } from './useSpaceHealth';

/**
 * Says when live updates are not arriving — and nothing at all when they are.
 *
 * The realtime state has been tracked since 001 but rendered nowhere, so a
 * degraded channel was invisible: the space simply stopped changing (finding
 * S5). Keep it quiet during a short reconnect, then offer an explicit retry.
 *
 * The header's health (070, US5) decides when this chip is shown and passes
 * the grace it has already waited out, so the chip does not start a second
 * eight-second wait of its own when it is mounted.
 */
export function RealtimeChip({ graceElapsed }: { graceElapsed?: boolean } = {}) {
  const { t } = useI18n();
  const { realtimeState, retryRealtime } = useTeam();
  const ownGrace = useRealtimeGrace(realtimeState);
  const elapsed = graceElapsed ?? ownGrace;

  if (realtimeState === 'disabled') {
    return (
      <WorkspaceChip tone="warn" label={t('teamRealtimeDisabled')}>
        {t('teamRealtimeDisabled')}
      </WorkspaceChip>
    );
  }
  // `connecting` used to be terminal and silent, which made the worse of the
  // two failures the quieter one: a channel that never came up at all said
  // nothing, while one that came up and dropped was announced. Kong accepting
  // the socket while its upstream is dead leaves the handshake hanging, so no
  // subscribe status ever fires and the state never leaves `connecting`
  // (FR-018).
  if (elapsed && (realtimeState === 'connecting' || realtimeState === 'reconnecting')) {
    return (
      /*
       * Pressable, because there is something to do (024, FR-052).
       *
       * It used to be a `<span>` that said live updates were not arriving and
       * left it there — the one chip of the four a reader most wants to act
       * on, and the only one that offered nothing. Retry remounts the existing
       * subscription and runs its catch-up read without losing the address.
       */
      <WorkspaceChip tone="warn" busy label={t('teamRealtimeRetry')} onPress={retryRealtime}>
        {t(realtimeState === 'connecting' ? 'teamRealtimeConnecting' : 'teamRealtimeReconnecting')}
      </WorkspaceChip>
    );
  }
  return null;
}
