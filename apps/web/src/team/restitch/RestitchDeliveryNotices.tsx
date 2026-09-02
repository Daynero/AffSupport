/**
 * What a member sees while a re-stitched download happens, and afterwards.
 *
 * Renders nothing of its own: it watches the deliveries the shell is running and keeps one
 * notice per material in step with them. Written as a component rather than an effect inside
 * the explorer because the explorer is already long, and because the empty-state path — a
 * space nobody has configured — needs somewhere to put the settings it offers to open.
 */

import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import { useTeam } from '../TeamContext';
import type { RestitchDeliveryPhase, RestitchDeliveryState } from './useRestitchDelivery';

const PHASE_KEYS = {
  transferring: 'teamRestitchPhaseTransferring',
  inspecting: 'teamRestitchPhaseInspecting',
  stitching: 'teamRestitchPhaseStitching',
  saving: 'teamRestitchPhaseSaving'
} as const satisfies Record<RestitchDeliveryPhase, string>;

export function RestitchDeliveryNotices({
  states,
  onConfigure
}: {
  states: Record<string, RestitchDeliveryState>;
  /** Opens the space's settings over the current view; absent when nobody may change them. */
  onConfigure: (() => void) | null;
}) {
  const { t } = useI18n();
  const { push, update, dismiss } = useToasts();
  const { can } = useTeam();
  // One live notice per material, so a second delivery does not stack a second toast on the
  // first and a finished one replaces its own progress rather than appearing beside it.
  const notices = useRef(new Map<string, number>());

  useEffect(() => {
    for (const [materialId, state] of Object.entries(states)) {
      const existing = notices.current.get(materialId);
      const notice = describe(state);
      if (!notice) continue;
      if (existing) update(existing, notice);
      else notices.current.set(materialId, push(notice));
    }

    function describe(state: RestitchDeliveryState) {
      if (state.kind === 'running') {
        return { tone: 'info' as const, text: t(PHASE_KEYS[state.phase]), sticky: true };
      }
      if (state.kind === 'delivered') {
        return {
          tone: 'success' as const,
          text: t('teamRestitchDelivered', { name: state.fileName })
        };
      }
      if (state.kind === 'failed') return { tone: 'error' as const, text: state.message };
      if (state.kind === 'unconfigured') {
        // Not a failure — the space simply has not been set up. Whoever can set it up is
        // offered the way in; whoever cannot is told who can, rather than handed a control
        // that would refuse them.
        return can('manage_metadata') && onConfigure
          ? {
              tone: 'info' as const,
              text: t('teamRestitchToastNotConfigured'),
              sticky: true,
              action: { label: t('teamRestitchToastConfigure'), run: onConfigure }
            }
          : {
              tone: 'info' as const,
              text: `${t('teamRestitchToastNotConfigured')} — ${t('teamRestitchToastAskManager')}`
            };
      }
      return null;
    }
  }, [states, t, push, update, dismiss, can, onConfigure]);

  return null;
}
