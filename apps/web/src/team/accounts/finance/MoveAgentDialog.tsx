import { useState } from 'react';
import type { FinanceSnapshot } from '@video-compressor/shared';
import {
  Button,
  Modal,
  Select,
  SearchField,
  Calendar,
  toCalendarDate,
  fromCalendarDate,
  ErrorState
} from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { teamFinanceApi } from '../../../api/team-finance';
import { teamErrorMessageFor } from '../../errors';

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
  const placement = snapshot.placements.find(p => p.agentRowId === agent && p.endsOn === null);
  const [target, setTarget] = useState('');
  const [date, setDate] = useState(today);
  const [request, setRequest] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const source = snapshot.accounts.find(a => a.id === placement?.accountId);
  const identity = snapshot.agents.find(a => a.id === agent);
  const blockedToday = snapshot.fields.some(
    f => f.agentRowId === agent && f.placementId === placement?.id && f.date === today
  );
  return (
    <Modal
      onClose={onClose}
      title={t('financeMove')}
      busy={busy}
      footer={
        <Button
          disabled={busy || !target || !placement || blockedToday}
          onClick={() => {
            if (!placement) return;
            setBusy(true);
            setError(null);
            void teamFinanceApi
              .move(
                snapshot.teamId,
                agent,
                target,
                date,
                placement.id,
                placement.version,
                timezone,
                request
              )
              .then(() => {
                onMoved();
                onClose();
              })
              .catch(cause => setError(teamErrorMessageFor(cause, t)))
              .finally(() => setBusy(false));
          }}
        >
          {t('financeMove')}
        </Button>
      }
    >
      <p className="font-medium break-words">
        {source?.name} / {identity?.agentId}
      </p>
      <p className="text-label text-ink-muted">{t('financeMoveHelp')}</p>
      {blockedToday && (
        <p role="status" className="text-label text-warning">
          {t('financeMoveBlockedToday')}
        </p>
      )}
      <SearchField
        aria-label={t('financeSearchTarget')}
        placeholder={t('financeSearchTarget')}
        value={query}
        onChange={setQuery}
        disabled={busy}
      />
      <Select
        aria-label={t('financeSearchTarget')}
        value={target}
        onChange={value => {
          setTarget(value);
          setRequest(crypto.randomUUID());
        }}
        disabled={busy}
        options={snapshot.accounts
          .filter(
            a =>
              a.id !== placement?.accountId &&
              (!query.trim() ||
                a.id === target ||
                a.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
          )
          .map(a => ({ value: a.id, label: a.name }))}
      />
      <Calendar
        label={t('financeDate')}
        value={toCalendarDate(date)}
        maxValue={toCalendarDate(today) ?? undefined}
        onChange={value => {
          if (busy) return;
          const next = fromCalendarDate(value);
          if (next) {
            setDate(next);
            setRequest(crypto.randomUUID());
          }
        }}
      />
      {error && <ErrorState message={error} />}
    </Modal>
  );
}
