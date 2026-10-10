import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  AdminOwnerSpace,
  AdminSpaceRequest,
  AdminTariffPreview,
  AdminTariffRow,
  TariffPlan
} from '@video-compressor/shared';
import type { AdminTariffClient, AdminUserMatch } from '../../api/team';
import {
  Alert,
  Button,
  Checkbox,
  Chip,
  FormField,
  Input,
  InputNumber,
  Modal,
  RadioGroup,
  SegmentedControl,
  Select,
  Textarea
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../../team/errors';
import { formatTariffDay } from '../../team/tariffs/format';
import { TariffDateField } from './TariffDateField';
import { addMonthsPreview, kyivToday } from './tariffModel';

/**
 * Granting a tariff (034, US1) — at most three presses from a request:
 * «Видати» on its row, a term, «Видати» here.
 *
 * What the dialog fills in on its own, so those three presses are enough:
 * the address and the wanted plan from the request, the person's only space,
 * and the extra seats a space that already holds more people than the plan's
 * base needs (US1.5). What it warns about: an address with no account yet —
 * the tariff then waits for that person's first sign-in (US1.2).
 */

export interface GrantPrefill {
  email?: string;
  plan?: string | null;
  teamId?: string | null;
  /** The request this grant answers, marked handled once it is granted. */
  requestUserId?: string | null;
  source: 'manual' | 'request' | 'legacy';
}

type Term = '1' | '3' | 'date';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function TariffGrantDialog({
  plans,
  prefill,
  requests,
  client,
  onClose,
  onGranted
}: {
  plans: readonly TariffPlan[];
  prefill: GrantPrefill;
  requests: readonly AdminSpaceRequest[];
  client: AdminTariffClient;
  onClose: () => void;
  onGranted: (row: AdminTariffRow, prefill: GrantPrefill) => void;
}) {
  const { t, language } = useI18n();
  const emailId = useId();
  const noteId = useId();
  const refId = useId();
  const seatsId = useId();
  const spaceId = useId();
  const [email, setEmail] = useState(prefill.email ?? '');
  const [plan, setPlan] = useState<string | null>(
    () =>
      plans.find(item => item.code === prefill.plan)?.code ??
      plans.find(item => item.highlight)?.code ??
      plans[0]?.code ??
      null
  );
  const [term, setTerm] = useState<Term>('1');
  const [date, setDate] = useState<string | null>(null);
  const [extraSeats, setExtraSeats] = useState(0);
  const seatsTouched = useRef(false);
  const [teamId, setTeamId] = useState<string | null>(prefill.teamId ?? null);
  const [spaces, setSpaces] = useState<AdminOwnerSpace[]>([]);
  const [preview, setPreview] = useState<AdminTariffPreview | null>(null);
  const [note, setNote] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [notify, setNotify] = useState(false);
  const [matches, setMatches] = useState<AdminUserMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = email.trim().toLocaleLowerCase('en-US');
  const valid = EMAIL.test(normalized);
  const selected = plans.find(item => item.code === plan) ?? null;
  const endsOn = term === 'date' ? date : addMonthsPreview(kyivToday(), Number(term));

  /* Suggestions as the address is typed: accounts, then requests. */
  useEffect(() => {
    if (normalized.length < 2 || !client.searchUsers) {
      setMatches([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void client.searchUsers?.(normalized).then(
        found => {
          if (active) setMatches(found);
        },
        () => undefined
      );
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, normalized]);

  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (value: string) => {
      const key = value.toLocaleLowerCase('en-US');
      if (key === normalized || seen.has(key)) return;
      seen.add(key);
      out.push(value);
    };
    for (const match of matches) add(match.email);
    if (normalized.length >= 2) {
      for (const request of requests) {
        if (request.email.toLocaleLowerCase('en-US').includes(normalized)) add(request.email);
      }
    }
    return out.slice(0, 6);
  }, [matches, normalized, requests]);

  /* The person's spaces: one is chosen for the grant, several are offered. */
  useEffect(() => {
    if (!valid) {
      setSpaces([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void client.listOwnerSpaces(normalized).then(
        found => {
          if (!active) return;
          setSpaces(found);
          if (prefill.teamId) return;
          const free = found.filter(space => !space.boundTariffId);
          setTeamId(free.length === 1 ? free[0]!.teamId : null);
        },
        () => {
          if (active) setSpaces([]);
        }
      );
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, normalized, prefill.teamId, valid]);

  /* Who already holds seats in that space, and whether the address has an account. */
  useEffect(() => {
    if (!valid) {
      setPreview(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void client.preview(normalized, teamId).then(
        value => {
          if (active) setPreview(value);
        },
        () => {
          if (active) setPreview(null);
        }
      );
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, normalized, teamId, valid]);

  /* Seats a space already uses beyond the plan's base, filled in until the admin edits them. */
  const neededSeats = selected && preview ? Math.max(0, preview.seatsUsed - selected.baseSeats) : 0;
  useEffect(() => {
    if (!seatsTouched.current) setExtraSeats(neededSeats);
  }, [neededSeats]);

  const submit = async () => {
    if (!valid || !plan || !endsOn) return;
    setBusy(true);
    setError(null);
    try {
      const row = await client.grant({
        email: normalized,
        plan,
        endsOn,
        extraSeats,
        teamId,
        note: note.trim() || null,
        externalRef: externalRef.trim() || null,
        notify,
        source: 'manual'
      });
      onGranted(row, prefill);
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const planOptions = plans.map(item => ({
    value: item.code,
    label: language === 'uk' ? item.nameUk : item.nameEn,
    description: t('tariffPlanSeats', { count: item.baseSeats })
  }));

  return (
    <Modal
      onClose={onClose}
      title={t('adminTariffGrantTitle')}
      size="md"
      busy={busy}
      initialFocus={prefill.email ? undefined : `[id="${emailId}"]`}
      footer={
        <>
          <Button color="neutral" variant="outline" disabled={busy} onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button
            color="primary"
            loading={busy}
            disabled={!valid || !plan || !endsOn}
            onClick={() => void submit()}
          >
            {endsOn
              ? t('adminTariffGrantSubmitUntil', { date: formatTariffDay(endsOn, language) })
              : t('adminTariffGrantSubmit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('email')} htmlFor={emailId}>
          <Input
            id={emailId}
            type="email"
            value={email}
            autoComplete="off"
            maxLength={320}
            onChange={event => setEmail(event.target.value)}
          />
        </FormField>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1" aria-label={t('adminTariffSuggestions')}>
            {suggestions.map(value => (
              <Chip key={value} onSelect={() => setEmail(value)}>
                {value}
              </Chip>
            ))}
          </div>
        )}
        {valid && preview && !preview.accountExists && (
          <Alert color="info" variant="subtle">
            {t('adminTariffNoAccount')}
          </Alert>
        )}

        {spaces.length > 1 && (
          <FormField label={<span id={spaceId}>{t('adminTariffSpace')}</span>}>
            <Select
              aria-labelledby={spaceId}
              value={teamId ?? ''}
              placeholder={t('adminTariffSpaceLater')}
              options={spaces.map(space => ({
                value: space.teamId,
                label: space.boundTariffId
                  ? t('adminTariffSpaceBound', { name: space.name })
                  : t('adminTariffSpaceOption', { name: space.name, count: space.membersUsed })
              }))}
              onChange={next => setTeamId(next || null)}
            />
          </FormField>
        )}

        {planOptions.length > 0 && (
          <RadioGroup
            variant="cards"
            label={t('adminTariffPlan')}
            value={plan}
            options={planOptions}
            onChange={setPlan}
          />
        )}

        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            label={t('adminTariffTerm')}
            value={term}
            options={[
              { value: '1', label: t('adminTariffTerm1') },
              { value: '3', label: t('adminTariffTerm3') },
              { value: 'date', label: t('adminTariffTermDate') }
            ]}
            onChange={setTerm}
          />
          {term === 'date' ? (
            <TariffDateField value={date} onChange={setDate} label={t('adminTariffEndsOn')} />
          ) : (
            endsOn && (
              <span className="text-ink-muted">
                {t('adminTariffUntilInclusive', { date: formatTariffDay(endsOn, language) })}
              </span>
            )
          )}
        </div>

        {(selected?.extraSeatsAllowed ?? true) && (
          <FormField label={t('adminTariffExtraSeats')} htmlFor={seatsId}>
            <InputNumber
              id={seatsId}
              value={extraSeats}
              min={0}
              max={selected?.maxExtraSeats ?? 500}
              steppers
              onChange={value => {
                seatsTouched.current = true;
                setExtraSeats(Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
              }}
            />
          </FormField>
        )}
        {preview && neededSeats > 0 && (
          <p className="text-caption text-ink-muted">
            {t('adminTariffSeatsAdded', { people: preview.seatsUsed, added: neededSeats })}
          </p>
        )}

        <FormField label={t('adminTariffNote')} htmlFor={noteId}>
          <Textarea
            id={noteId}
            rows={2}
            value={note}
            maxLength={500}
            onChange={event => setNote(event.target.value)}
          />
        </FormField>
        <FormField label={t('adminTariffExternalRef')} htmlFor={refId}>
          <Input
            id={refId}
            value={externalRef}
            maxLength={500}
            onChange={event => setExternalRef(event.target.value)}
          />
        </FormField>
        <Checkbox label={t('adminTariffNotify')} checked={notify} onChange={setNotify} />

        {error && (
          <Alert color="error" live="alert">
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
