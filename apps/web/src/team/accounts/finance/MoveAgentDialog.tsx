import { useEffect, useRef, useState } from 'react';
import type { FinanceSnapshot } from '@video-compressor/shared';
import {
  Button,
  Modal,
  Select,
  SearchField,
  Calendar,
  toCalendarDate,
  fromCalendarDate,
  ErrorState,
  LoadingState
} from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { teamFinanceApi } from '../../../api/team-finance';
import { TeamApiError } from '../../../api/team';
import { teamErrorMessageFor } from '../../errors';
import { AgentIdentity } from '../AgentIdentity';
import { formatFinanceAmount } from './formatFinanceAmount';

type Eligibility = Awaited<ReturnType<typeof teamFinanceApi.transferEligibility>>;
type Attempt = Parameters<typeof teamFinanceApi.move>;

export function MoveAgentDialog({
  snapshot,
  agent,
  today,
  timezone,
  onClose,
  onMoved
}: {
  snapshot: FinanceSnapshot;
  agent: string;
  today: string;
  timezone: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState('');
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [checking, setChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  useEffect(() => {
    let active = true;
    setChecking(true);
    void teamFinanceApi
      .transferEligibility(snapshot.teamId, agent, timezone)
      .then(result => {
        if (!active) return;
        setEligibility(result);
        setDate(old => (old < result.minDate && result.minDate <= today ? result.minDate : old));
      })
      .catch(cause => {
        if (active) {
          setEligibility(null);
          setError(teamErrorMessageFor(cause, t));
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [snapshot.teamId, agent, timezone, today, revision, t]);
  const source = snapshot.accounts.find(
    a =>
      a.id ===
      (eligibility?.accountId ??
        snapshot.placements.find(p => p.agentRowId === agent && p.endsOn === null)?.accountId)
  );
  const identity = snapshot.agents.find(a => a.id === agent);
  const locked = busy || uncertain;
  const options = snapshot.accounts.filter(
    a =>
      a.id !== eligibility?.accountId &&
      (!query.trim() || a.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  );
  const unavailable = !eligibility || eligibility.minDate > today;
  const move = async () => {
    if (!attempt.current) {
      if (!eligibility || !target || unavailable || date < eligibility.minDate) return;
      attempt.current = [
        snapshot.teamId,
        agent,
        target,
        date,
        eligibility.placementId,
        eligibility.placementVersion,
        timezone,
        crypto.randomUUID()
      ];
    }
    setBusy(true);
    setError(null);
    try {
      await teamFinanceApi.move(...attempt.current);
      onMoved();
      onClose();
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
      if (cause instanceof TeamApiError && cause.code !== 'INVALID_RESPONSE' && !cause.retryable) {
        // A definite server rejection rolls back; recheck before a new attempt.
        attempt.current = null;
        setUncertain(false);
        setRevision(value => value + 1);
      } else {
        // The server may have committed. Freeze every argument, including CAS,
        // so a reread cannot change the meaning of this idempotent retry.
        setUncertain(true);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex flex-wrap items-center gap-1">
          {t('financeMoveTitle')}{' '}
          <AgentIdentity accountName="" agentId={identity?.agentId ?? ''} revealed />{' '}
          {t('financeMoveFrom', { account: source?.name ?? '' })}
        </span>
      }
      busy={busy}
      footer={
        <Button
          disabled={
            busy ||
            (!uncertain &&
              (checking || !target || unavailable || date < eligibility!.minDate || date > today))
          }
          onClick={() => {
            void move();
          }}
        >
          {uncertain ? t('retry') : t('financeMove')}
        </Button>
      }
    >
      <p className="text-label text-ink-muted">{t('financeMoveHelp')}</p>
      {checking && <LoadingState label={t('financeMove')} />}
      {eligibility && eligibility.blockers.length > 0 && (
        <div role="status" className="text-label text-warning">
          <p>{t('financeMoveEarliest', { date: eligibility.minDate })}</p>
          {eligibility.blockers.map(row => (
            <p key={`${row.date}/${row.metric}`}>
              {row.date} ·{' '}
              {t(
                row.metric === 'balance'
                  ? 'financeBalance'
                  : row.metric === 'topup'
                    ? 'financeTopup'
                    : 'financeSpend'
              )}{' '}
              ·{' '}
              {row.value === null
                ? t('financeMoveClearedEntry')
                : `${formatFinanceAmount(row.value)} USD`}
            </p>
          ))}
          {unavailable && <p>{t('financeMoveWait')}</p>}
        </div>
      )}
      <SearchField
        aria-label={t('financeSearchTarget')}
        placeholder={t('financeSearchTarget')}
        value={query}
        onChange={value => {
          setQuery(value);
          setTarget('');
        }}
        disabled={locked}
      />
      {query.trim() && (
        <p className="text-label text-ink-muted" role="status">
          {t('financeMoveResults', { count: options.length })}
        </p>
      )}
      <Select
        aria-label={t('financeMoveSelect')}
        placeholder={t('financeMoveSelect')}
        value={target}
        onChange={setTarget}
        disabled={locked || checking}
        options={options.map(a => ({ value: a.id, label: a.name }))}
      />
      <p className="text-label">{t('financeMoveDateHelp')}</p>
      <Calendar
        label={t('financeDate')}
        value={toCalendarDate(date)}
        minValue={toCalendarDate(unavailable ? today : eligibility!.minDate) ?? undefined}
        maxValue={toCalendarDate(today) ?? undefined}
        isDateUnavailable={value =>
          locked || unavailable || value.toString() < eligibility!.minDate
        }
        onChange={value => {
          if (locked) return;
          const next = fromCalendarDate(value);
          if (next) setDate(next);
        }}
      />
      {uncertain && (
        <p role="status" className="text-label">
          {t('financeMoveRetryHelp')}
        </p>
      )}
      {error && (
        <ErrorState
          message={error}
          onRetry={uncertain ? undefined : () => setRevision(value => value + 1)}
          retryLabel={t('retry')}
        />
      )}
    </Modal>
  );
}
