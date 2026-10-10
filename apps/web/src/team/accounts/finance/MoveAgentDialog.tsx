import { useEffect, useRef, useState } from 'react';
import type { FinanceSnapshot } from '@video-compressor/shared';
import {
  Button,
  Modal,
  Select,
  SearchField,
  ErrorState,
  LoadingState
} from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { teamFinanceApi } from '../../../api/team-finance';
import { TeamApiError } from '../../../api/team';
import { teamErrorMessageFor } from '../../errors';
import { AgentIdentity } from '../AgentIdentity';

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
  /** Only who is where: the finance board passes its snapshot, the accounts list builds one. */
  snapshot: Pick<FinanceSnapshot, 'teamId' | 'accounts' | 'agents' | 'placements'>;
  agent: string;
  today: string;
  timezone: string;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState('');
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
  }, [snapshot.teamId, agent, timezone, revision, t]);
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
  // One match is the answer: picking it again from a list of one is a step for nothing.
  const onlyMatch = query.trim() && options.length === 1 ? options[0]!.id : null;
  useEffect(() => {
    if (onlyMatch && !locked) setTarget(onlyMatch);
  }, [onlyMatch, locked]);
  const move = async () => {
    if (!attempt.current) {
      if (!eligibility || !target) return;
      // The server no longer splits money at a date: every sum moves with the
      // ad account. Today is sent only because the RPC's signature keeps it.
      attempt.current = [
        snapshot.teamId,
        agent,
        target,
        today,
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
          disabled={busy || (!uncertain && (checking || !eligibility || !target))}
          onClick={() => {
            void move();
          }}
        >
          {uncertain ? t('retry') : t('financeMove')}
        </Button>
      }
    >
      <p role="note" className="text-label text-error-text">
        {t('financeMoveWarning', { account: source?.name ?? '' })}
      </p>
      <p className="text-label text-ink-muted">{t('financeMoveHelp')}</p>
      {checking && <LoadingState label={t('financeMove')} />}
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
      {query.trim() && !onlyMatch && (
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
