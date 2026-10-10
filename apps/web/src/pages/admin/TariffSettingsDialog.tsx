import { useId, useState } from 'react';
import { normalizeTelegramLogin, type AdminTariffSettings } from '@video-compressor/shared';
import type { AdminTariffClient } from '../../api/team';
import {
  Alert,
  Button,
  ConfirmDialog,
  FormField,
  Input,
  Modal,
  Switch
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../../team/errors';

/**
 * Tariff settings (034, US3.8, R14): where people write to the administrator,
 * and the old rule. Switching the rule off while spaces still rely on it is
 * allowed only with a second, explicit yes — those spaces are paused at once
 * (US2.3), and the confirmation says how many.
 */
export function TariffSettingsDialog({
  settings,
  client,
  onClose,
  onSaved
}: {
  settings: AdminTariffSettings;
  client: AdminTariffClient;
  onClose: () => void;
  onSaved: (settings: AdminTariffSettings) => void;
}) {
  const { t } = useI18n();
  const telegramId = useId();
  const emailId = useId();
  const [telegram, setTelegram] = useState(settings.telegram ?? '');
  const [email, setEmail] = useState(settings.email ?? '');
  const [legacy, setLegacy] = useState(settings.legacyRuleEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const telegramValue = telegram.trim();
  const telegramValid = telegramValue === '' || normalizeTelegramLogin(telegramValue) !== null;
  const emailValue = email.trim();
  const emailValid = emailValue === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(emailValue);

  const save = async (confirm = false) => {
    if (!telegramValid || !emailValid) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await client.setSettings({
          telegram: telegramValue ? normalizeTelegramLogin(telegramValue) : null,
          email: emailValue || null,
          legacyRuleEnabled: legacy,
          confirm
        })
      );
    } catch (cause) {
      if (teamErrorCodeOf(cause) === 'LEGACY_SPACES_REMAIN') setConfirming(true);
      else setError(teamErrorMessageFor(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        onClose={onClose}
        title={t('adminTariffSettingsTitle')}
        size="sm"
        busy={busy}
        footer={
          <>
            <Button color="neutral" variant="outline" disabled={busy} onClick={onClose}>
              {t('teamCancel')}
            </Button>
            <Button
              color="primary"
              loading={busy}
              disabled={!telegramValid || !emailValid}
              onClick={() => void save()}
            >
              {t('adminTariffSave')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField
            label={t('adminTariffSettingsTelegram')}
            htmlFor={telegramId}
            hint={t('adminTariffSettingsTelegramHint')}
            error={telegramValid ? undefined : t('adminTariffSettingsTelegramInvalid')}
          >
            <Input
              id={telegramId}
              value={telegram}
              invalid={!telegramValid}
              maxLength={33}
              onChange={event => setTelegram(event.target.value)}
            />
          </FormField>
          <FormField
            label={t('adminTariffSettingsEmail')}
            htmlFor={emailId}
            error={emailValid ? undefined : t('adminTariffSettingsEmailInvalid')}
          >
            <Input
              id={emailId}
              type="email"
              value={email}
              invalid={!emailValid}
              maxLength={320}
              onChange={event => setEmail(event.target.value)}
            />
          </FormField>
          <Switch label={t('adminTariffSettingsLegacy')} checked={legacy} onChange={setLegacy} />
          <p className="text-caption text-ink-muted prose">
            {settings.legacySpacesRemaining > 0
              ? t('adminTariffSettingsLegacyRemain', { count: settings.legacySpacesRemaining })
              : t('adminTariffSettingsLegacyClear')}
          </p>
          {error && (
            <Alert color="error" live="alert">
              {error}
            </Alert>
          )}
        </div>
      </Modal>
      {confirming && (
        <ConfirmDialog
          nested
          title={t('adminTariffLegacyConfirmTitle')}
          body={t('adminTariffLegacyConfirmBody', { count: settings.legacySpacesRemaining })}
          confirmLabel={t('adminTariffLegacyConfirm')}
          cancelLabel={t('teamCancel')}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void save(true);
          }}
        />
      )}
    </>
  );
}
