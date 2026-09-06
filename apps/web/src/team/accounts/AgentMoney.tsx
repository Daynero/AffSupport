/**
 * The two figures an agent carries (019): what it has left, and what to add.
 *
 * They sit in one cell between the runs and the row's buttons, each four
 * characters wide with a caption above it — the widest figure anybody types
 * here is `9999`, and a wider field would take the room the runs are read in.
 *
 * The top-up has − and + beside it because it is written in fifties: a person
 * walking the list decides "another fifty", not "one hundred and fifty", and a
 * press is faster and surer than the four keystrokes it replaces. Both figures
 * are written together, when the field is left or Enter is pressed — a write
 * per keystroke would be a round trip per digit.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  TEAM_AGENT_TOPUP_STEP,
  normalizeTeamAgentAmount,
  stepTeamAgentTopup,
  type TeamAccountAgentSummary
} from '@video-compressor/shared';
import { ICON_STROKE } from '../../components/icons';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

function text(amount: number | null): string {
  return amount === null ? '' : String(amount);
}

export function AgentMoney({
  agent,
  label,
  canEdit,
  disabled = false,
  onSet
}: {
  agent: TeamAccountAgentSummary;
  /** The agent's own name, so each field says which row it belongs to. */
  label: string;
  canEdit: boolean;
  disabled?: boolean;
  onSet: (balance: number | null, topup: number | null) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const balanceId = useId();
  const topupId = useId();
  const [balance, setBalance] = useState(text(agent.balance));
  const [topup, setTopup] = useState(text(agent.topup));
  const [saving, setSaving] = useState(false);
  /** What the fields held when they were last agreed with the server. */
  const saved = useRef({ balance: agent.balance, topup: agent.topup });
  /** Whether a caret is in one of the two fields right now. */
  const editing = useRef(false);

  // A teammate's figure, or an undo, replaces what is on screen — unless a
  // write of ours is in flight or a caret is in the field, where it would
  // delete what is being typed as it is typed.
  useEffect(() => {
    if (saving || editing.current) return;
    saved.current = { balance: agent.balance, topup: agent.topup };
    setBalance(text(agent.balance));
    setTopup(text(agent.topup));
  }, [agent.balance, agent.topup, saving]);

  const commit = async (next: { balance?: string; topup?: string } = {}) => {
    const balanceText = next.balance ?? balance;
    const topupText = next.topup ?? topup;
    const nextBalance = normalizeTeamAgentAmount(balanceText);
    const nextTopup = normalizeTeamAgentAmount(topupText);
    if (nextBalance === undefined || nextTopup === undefined) {
      // Refused: the fields go back to the last figures anyone agreed on
      // rather than sitting there holding something that was never saved.
      setBalance(text(saved.current.balance));
      setTopup(text(saved.current.topup));
      push({ tone: 'error', text: t('teamAgentMoneyInvalid') });
      return;
    }
    if (nextBalance === saved.current.balance && nextTopup === saved.current.topup) return;
    setSaving(true);
    try {
      await onSet(nextBalance, nextTopup);
      saved.current = { balance: nextBalance, topup: nextTopup };
    } catch (cause) {
      setBalance(text(saved.current.balance));
      setTopup(text(saved.current.topup));
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
      (event.target as HTMLInputElement).blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setBalance(text(saved.current.balance));
      setTopup(text(saved.current.topup));
    }
  };

  /** A press of − or +: the next fifty, written at once. */
  const step = (direction: 1 | -1) => {
    const current = normalizeTeamAgentAmount(topup);
    const next = stepTeamAgentTopup(current === undefined ? null : current, direction);
    setTopup(text(next));
    void commit({ topup: text(next) });
  };

  const busy = saving || disabled;

  return (
    <div className="team-agent-money">
      <label className="team-agent-money-field" htmlFor={balanceId}>
        <span className="team-agent-money-caption">{t('teamAgentBalance')}</span>
        <input
          id={balanceId}
          className="team-agent-money-input"
          inputMode="numeric"
          maxLength={4}
          value={balance}
          disabled={!canEdit || busy}
          aria-label={`${t('teamAgentBalance')} ${label}`}
          placeholder="—"
          onChange={event => setBalance(event.target.value.replace(/\D/gu, '').slice(0, 4))}
          onKeyDown={onKeyDown}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
            void commit();
          }}
        />
      </label>
      {/* The caption sits over the field itself, not over the field and its two
          presses: above the whole stepper it read as a label for the − beside
          it, and the two columns stopped lining up. */}
      <div className="team-agent-money-stepper">
        {canEdit && (
          <button
            type="button"
            className="team-agent-money-step"
            aria-label={t('teamAgentTopupLess', { step: TEAM_AGENT_TOPUP_STEP, agent: label })}
            disabled={busy || (agent.topup === null && topup === '')}
            onClick={() => step(-1)}
          >
            <Minus size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
        <label className="team-agent-money-field" htmlFor={topupId}>
          <span className="team-agent-money-caption">{t('teamAgentTopup')}</span>
          <input
            id={topupId}
            className="team-agent-money-input"
            inputMode="numeric"
            maxLength={4}
            value={topup}
            disabled={!canEdit || busy}
            aria-label={`${t('teamAgentTopup')} ${label}`}
            placeholder="—"
            onChange={event => setTopup(event.target.value.replace(/\D/gu, '').slice(0, 4))}
            onKeyDown={onKeyDown}
            onFocus={() => {
              editing.current = true;
            }}
            onBlur={() => {
              editing.current = false;
              void commit();
            }}
          />
        </label>
        {canEdit && (
          <button
            type="button"
            className="team-agent-money-step"
            aria-label={t('teamAgentTopupMore', { step: TEAM_AGENT_TOPUP_STEP, agent: label })}
            disabled={busy}
            onClick={() => step(1)}
          >
            <Plus size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
