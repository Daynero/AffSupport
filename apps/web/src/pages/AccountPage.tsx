import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { analytics } from '../analytics/service';
import { useAgent } from '../AgentContext';
import { Button, Checkbox } from '../components/ui';
import { UserAvatar } from '../components/UserAvatar';
import { useI18n, type Language, type TranslationKey } from '../i18n';
import { publicConfig } from '../lib/config';
import { requireSupabaseClient } from '../lib/supabase';

function dateValue(value: string | null, language: Language, never: string) {
  if (!value) return never;
  return new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value));
}

const planKeys = { free: 'freePlan', pro: 'proPlan', team: 'teamPlan' } as const;
const statusKeys = {
  active: 'activeStatus',
  blocked: 'blockedStatus',
  deleted: 'deletedStatus'
} as const;

export default function AccountPage() {
  const { profile, user, updateProfile, signOut } = useAuth();
  const { agentVersion } = useAgent();
  const { language: currentLanguage, setLanguage, t } = useI18n();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [language, setFormLanguage] = useState<Language>(profile?.language ?? currentLanguage);
  const [marketing, setMarketing] = useState(profile?.marketing_consent ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    document.title = `${t('accountTitle')} — Wishly`;
  }, [t]);

  if (!profile || !user) return null;
  const expectedConfirmation = currentLanguage === 'uk' ? 'ВИДАЛИТИ' : 'DELETE';

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFormError(false);
    try {
      const consentChanged = marketing !== profile.marketing_consent;
      await updateProfile({ display_name: displayName, language, marketing_consent: marketing });
      setLanguage(language);
      if (consentChanged)
        analytics.track('marketing_consent_changed', { marketing_consent: marketing });
      setSaved(true);
    } catch {
      setFormError(true);
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = async () => {
    if (!publicConfig.ok || !publicConfig.value.deleteAccountEnabled) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      const supabase = requireSupabaseClient();
      const { error } = await supabase.functions.invoke('delete-account');
      if (error) throw error;
      await supabase.auth.signOut({ scope: 'local' });
      analytics.setUser(null);
      dialog.current?.close();
      location.replace('/login');
    } catch {
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="account-page page-container">
      <header className="page-heading">
        <div>
          <h2>{t('accountTitle')}</h2>
          <p>{t('accountSubtitle')}</p>
        </div>
      </header>

      <section className="account-card profile-card" aria-labelledby="profile-heading">
        <div className="profile-summary">
          <UserAvatar
            url={profile.avatar_url}
            name={profile.display_name}
            email={profile.email}
            alt={t('avatarAlt')}
            size="large"
          />
          <div>
            <h3 id="profile-heading">{profile.display_name || profile.email}</h3>
            <span>{profile.email}</span>
          </div>
        </div>
        <div className="account-form-grid">
          <label className="field">
            <span>{t('displayName')}</span>
            <input
              value={displayName}
              maxLength={120}
              autoComplete="name"
              onChange={event => setDisplayName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>{t('language')}</span>
            <select
              value={language}
              onChange={event => setFormLanguage(event.target.value as Language)}
            >
              <option value="uk">Українська</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        <Checkbox
          checked={marketing}
          onChange={event => setMarketing(event.target.checked)}
          label={t('marketingConsent')}
        />
        <small className="field-help">{t('marketingOptional')}</small>
        {formError && <div className="inline-alert inline-alert-error">{t('profileError')}</div>}
        {saved && <div className="inline-alert inline-alert-success">{t('changesSaved')}</div>}
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {t('saveChanges')}
        </Button>
      </section>

      <section className="account-card" aria-labelledby="account-details-heading">
        <h3 id="account-details-heading">{t('account')}</h3>
        <dl className="account-details">
          <Detail label={t('email')} value={profile.email ?? t('notAvailable')} />
          <Detail label={t('provider')} value={t('google')} />
          <Detail
            label={t('accountCreated')}
            value={dateValue(profile.created_at, currentLanguage, t('never'))}
          />
          <Detail
            label={t('lastActive')}
            value={dateValue(profile.last_seen_at, currentLanguage, t('never'))}
          />
          <Detail label={t('plan')} value={t(planKeys[profile.plan] as TranslationKey)} />
          <Detail
            label={t('accountStatus')}
            value={t(statusKeys[profile.account_status] as TranslationKey)}
          />
          <Detail label={t('agentVersion')} value={agentVersion ?? t('notAvailable')} />
        </dl>
        <Button onClick={() => void signOut()}>{t('signOut')}</Button>
      </section>

      <section className="account-card danger-card" aria-labelledby="data-heading">
        <div>
          <h3 id="data-heading">{t('dataManagement')}</h3>
          <p>{t('dataManagementBody')}</p>
        </div>
        <Button
          variant="danger"
          disabled={!publicConfig.ok || !publicConfig.value.deleteAccountEnabled}
          onClick={() => dialog.current?.showModal()}
        >
          {t('deleteAccount')}
        </Button>
        {(!publicConfig.ok || !publicConfig.value.deleteAccountEnabled) && (
          <small>{t('deleteUnavailable')}</small>
        )}
      </section>

      <dialog className="confirm-dialog" ref={dialog} onClose={() => setConfirmation('')}>
        <form method="dialog" onSubmit={event => event.preventDefault()}>
          <h2>{t('deleteDialogTitle')}</h2>
          <p>{t('deleteDialogBody')}</p>
          <label className="field">
            <span>{t('deleteConfirmationLabel')}</span>
            <input
              value={confirmation}
              autoComplete="off"
              placeholder={t('deleteConfirmationPlaceholder')}
              onChange={event => setConfirmation(event.target.value)}
            />
          </label>
          {deleteError && (
            <div className="inline-alert inline-alert-error">{t('deleteFailed')}</div>
          )}
          <div className="dialog-actions">
            <Button type="button" onClick={() => dialog.current?.close()}>
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={deleting}
              disabled={confirmation !== expectedConfirmation}
              onClick={() => void removeAccount()}
            >
              {t('deletePermanently')}
            </Button>
          </div>
        </form>
      </dialog>
    </main>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
