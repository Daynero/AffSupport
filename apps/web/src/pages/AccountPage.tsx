import { useEffect, useState } from 'react';
import { PRODUCT_VERSION, RELEASE_DOWNLOAD_URL } from '@video-compressor/shared';
import { useAuth } from '../auth/AuthContext';
import { analytics } from '../analytics/service';
import { useAgent } from '../AgentContext';
import { Button, Checkbox } from '../components/ui';
import { UserAvatar } from '../components/UserAvatar';
import { useI18n, type Language } from '../i18n';

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

  useEffect(() => {
    document.title = `${t('accountTitle')} — Wishly`;
  }, [t]);

  if (!profile || !user) return null;

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
          <div>
            <dt>{t('agentVersion')}</dt>
            <dd>
              {agentVersion ?? t('notAvailable')}
              {agentVersion === PRODUCT_VERSION ? (
                <span className="agent-version-note"> ({t('latestVersion')})</span>
              ) : (
                <span className="agent-version-note">
                  {' ('}
                  <a href={RELEASE_DOWNLOAD_URL}>
                    {agentVersion ? t('updateAgent') : t('downloadShort')}
                  </a>
                  {')'}
                </span>
              )}
            </dd>
          </div>
        </dl>
        <Button onClick={() => void signOut()}>{t('signOut')}</Button>
      </section>
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
