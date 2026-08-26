import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';

/**
 * A brief drop — or a slow first connect — is normal and self-healing;
 * announcing either immediately would make the header flicker on every tab
 * switch. Only a wait that is still unresolved after this long is worth saying
 * out loud.
 */
const WAITING_GRACE_MS = 8_000;

/** The two states in which live events are not arriving and we are still trying. */
const WAITING: ReadonlySet<string> = new Set(['connecting', 'reconnecting']);

/**
 * Says when live updates are not arriving — and nothing at all when they are.
 *
 * The realtime state has been tracked since 001 but rendered nowhere, so a
 * degraded channel was invisible: the space simply stopped changing (finding
 * S5). This is deliberately quiet, because the fallback poll means degraded no
 * longer means broken.
 */
export function RealtimeChip() {
  const { t } = useI18n();
  const { realtimeState } = useTeam();
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    if (!WAITING.has(realtimeState)) {
      setGraceElapsed(false);
      return;
    }
    // Moving between the two waiting states restarts the timer but does not
    // clear an elapsed grace: once we have said live updates are missing,
    // saying it differently is not a reason to go quiet and flicker back.
    const timer = window.setTimeout(() => setGraceElapsed(true), WAITING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [realtimeState]);

  if (realtimeState === 'disabled') {
    return (
      <span className="ui-chip ui-chip-warn" role="status">
        {t('teamRealtimeDisabled')}
      </span>
    );
  }
  // `connecting` used to be terminal and silent, which made the worse of the
  // two failures the quieter one: a channel that never came up at all said
  // nothing, while one that came up and dropped was announced. Kong accepting
  // the socket while its upstream is dead leaves the handshake hanging, so no
  // subscribe status ever fires and the state never leaves `connecting`
  // (FR-018).
  if (graceElapsed && WAITING.has(realtimeState)) {
    return (
      <span className="ui-chip ui-chip-warn" role="status">
        <span className="ui-chip-spinner" aria-hidden="true" />
        {t(realtimeState === 'connecting' ? 'teamRealtimeConnecting' : 'teamRealtimeReconnecting')}
      </span>
    );
  }
  return null;
}
