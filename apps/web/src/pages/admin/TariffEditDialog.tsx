import { useEffect, useId, useState } from 'react';
import type { AdminTariffRow, TariffPlan } from '@video-compressor/shared';
import type { AdminTariffClient, DriveApprovalPreview } from '../../api/team';
import {
  Alert,
  Button,
  Checkbox,
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
  const googleId = useId();
  const [googleEmail, setGoogleEmail] = useState('');
  const [googlePreview, setGooglePreview] = useState<DriveApprovalPreview | null>(null);
  const [googleConfirmed, setGoogleConfirmed] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setGooglePreview(null);
    setGoogleConfirmed(false);
    setPreviewError(null);
    if (!row.ownerId || !googleEmail.trim()) return;
    const timer = window.setTimeout(() => {
      void client.previewDriveApproval(row.ownerId!, googleEmail.trim()).then(
        value => {
          if (active) setGooglePreview(value);
        },
        cause => {
          if (active) setPreviewError(teamErrorMessageFor(cause, t));
        }
      );
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, row.ownerId, googleEmail, t]);
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
    if (googleEmail.trim() && (!googlePreview || !googleConfirmed)) return;
    setBusy(true);
    setError(null);
    setSeatsInUse(false);
    try {
      onSaved(
        await client.update({
          id: row.id,
          expectedUpdatedAt: row.updatedAt,
          plan,
          endsOn,
          extraSeats: plan === 'solo' ? 0 : extraSeats,
          note: note.trim() || null,
          externalRef: externalRef.trim() || null,
          ...(googleEmail.trim() && googlePreview && googleConfirmed
            ? {
                approvedGoogleEmail: googleEmail.trim(),
                googleApprovalRevision: googlePreview.revision
              }
            : {})
        })
      );
    } catch (cause) {
      if (googleEmail.trim()) {
        setGoogleConfirmed(false);
        void client
          .previewDriveApproval(row.ownerId!, googleEmail.trim())
          .then(setGooglePreview, () => setGooglePreview(null));
      }
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
          <Button
            color="primary"
            loading={busy}
            disabled={Boolean(googleEmail.trim()) && (!googlePreview || !googleConfirmed)}
            onClick={() => void save()}
          >
            {t(googleEmail.trim() ? 'adminTariffSaveGoogle' : 'adminTariffSave')}
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
            onChange={next => {
              setPlan(next);
              if (next === 'solo') setExtraSeats(0);
            }}
          />
        </FormField>
        <FormField label={t('adminTariffEndsOn')}>
          <TariffDateField
            tariffToday={row.tariffToday}
            value={endsOn}
            onChange={setEndsOn}
            label={t('adminTariffEndsOn')}
          />
        </FormField>
        {plan !== 'solo' && (selected?.extraSeatsAllowed ?? true) && (
          <FormField label={t('adminTariffExtraSeats')} htmlFor={seatsId}>
            <InputNumber
              id={seatsId}
              value={extraSeats}
              min={0}
              max={Math.min(selected?.maxExtraSeats ?? 1999, 2000 - (selected?.baseSeats ?? 1))}
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
        {row.ownerId && (
          <FormField label={t('adminTariffGoogleAccount')} htmlFor={googleId}>
            <Input
              id={googleId}
              disabled={busy}
              type="email"
              value={googleEmail}
              maxLength={320}
              onChange={event => {
                setGoogleEmail(event.target.value);
                setGoogleConfirmed(false);
                setGooglePreview(null);
              }}
            />
            <p className="text-caption text-ink-muted">{t('adminTariffGoogleAccountHint')}</p>
            {googlePreview && (
              <>
                <Alert color="warning">
                  {t('adminTariffGoogleScope', { count: googlePreview.spaces.length })}
                </Alert>
                {googlePreview.spaces.length > 0 && (
                  <ul>
                    {googlePreview.spaces.map(space => (
                      <li key={space.id}>{space.name}</li>
                    ))}
                  </ul>
                )}
                <Checkbox
                  checked={googleConfirmed}
                  onChange={setGoogleConfirmed}
                  label={t('adminTariffGoogleConfirm')}
                />
              </>
            )}
            {previewError && <Alert color="error">{previewError}</Alert>}
          </FormField>
        )}
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
