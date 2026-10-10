import { useId, useState } from 'react';
import type { AdminTariffRow, TariffPlan } from '@video-compressor/shared';
import type { AdminTariffClient } from '../../api/team';
import {
  Alert,
  Button,
  FormField,
  Input,
  InputNumber,
  Modal,
  Select,
  Textarea
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../../team/errors';
import { TariffDateField } from './TariffDateField';

/**
 * «Змінити» (034, US3.3): plan, last day, extra seats, the note and the payment
 * reference, in one form. Seats cannot go below the people already holding
 * them (US3.5) — the server refuses with `SEATS_IN_USE`, and the dialog then
 * offers the list of who holds them, where someone can be taken off.
 */
export function TariffEditDialog({
  row,
  plans,
  client,
  onClose,
  onSaved,
  onShowSeats
}: {
  row: AdminTariffRow;
  plans: readonly TariffPlan[];
  client: AdminTariffClient;
  onClose: () => void;
  onSaved: (row: AdminTariffRow) => void;
  onShowSeats: (row: AdminTariffRow) => void;
}) {
  const { t, language } = useI18n();
  const planId = useId();
  const seatsId = useId();
  const noteId = useId();
  const refId = useId();
  const [plan, setPlan] = useState(row.planCode);
  const [endsOn, setEndsOn] = useState(row.endsOn);
  const [extraSeats, setExtraSeats] = useState(row.extraSeats);
  const [note, setNote] = useState(row.note ?? '');
  const [externalRef, setExternalRef] = useState(row.externalRef ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seatsInUse, setSeatsInUse] = useState(false);
  const selected = plans.find(item => item.code === plan) ?? null;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSeatsInUse(false);
    try {
      onSaved(
        await client.update({
          id: row.id,
          plan,
          endsOn,
          extraSeats,
          note: note.trim() || null,
          externalRef: externalRef.trim() || null
        })
      );
    } catch (cause) {
      setSeatsInUse(teamErrorCodeOf(cause) === 'SEATS_IN_USE');
      setError(teamErrorMessageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t('adminTariffEditTitle', { email: row.ownerEmail })}
      size="md"
      busy={busy}
      footer={
        <>
          <Button color="neutral" variant="outline" disabled={busy} onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button color="primary" loading={busy} onClick={() => void save()}>
            {t('adminTariffSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={<span id={planId}>{t('adminTariffPlan')}</span>}>
          <Select
            aria-labelledby={planId}
            value={plan}
            options={plans.map(item => ({
              value: item.code,
              label: language === 'uk' ? item.nameUk : item.nameEn
            }))}
            onChange={setPlan}
          />
        </FormField>
        <FormField label={t('adminTariffEndsOn')}>
          <TariffDateField value={endsOn} onChange={setEndsOn} label={t('adminTariffEndsOn')} />
        </FormField>
        {(selected?.extraSeatsAllowed ?? true) && (
          <FormField label={t('adminTariffExtraSeats')} htmlFor={seatsId}>
            <InputNumber
              id={seatsId}
              value={extraSeats}
              min={0}
              max={selected?.maxExtraSeats ?? 500}
              steppers
              onChange={value =>
                setExtraSeats(Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0)
              }
            />
          </FormField>
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
        {error && (
          <Alert
            color="error"
            live="alert"
            action={
              seatsInUse && row.teamId ? (
                <Button
                  size="sm"
                  color="neutral"
                  variant="outline"
                  onClick={() => onShowSeats(row)}
                >
                  {t('adminTariffShowSeats')}
                </Button>
              ) : undefined
            }
          >
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
