import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { analytics } from '../analytics/service';
import { useAgent } from '../AgentContext';
import { Card } from '../components/Card';
import { Button, Checkbox, type Translate } from '../components/ui';
import { UserAvatar } from '../components/UserAvatar';
import { useI18n, type Language } from '../i18n';
import type { Profile } from '../lib/database.types';
import { usePageEntrance } from '../lib/navigation';
import { installedReleaseStatus, macAppleSiliconDownloadUrl } from '../release-manifest';

export default function AccountPage() {
  const { profile, user } = useAuth();
  const { t } = useI18n();
  const entering = usePageEntrance();
  // Remembers that this mount showed the skeleton, so the real content
  // crossfades in (content-appear) instead of popping when the profile lands.
  const sawSkeleton = useRef(false);

  useEffect(() => {
    document.title = `${t('accountTitle')} — Wishly`;
  }, [t]);

  if (!profile || !user) {
    sawSkeleton.current = true;
    return (
      <main
        className={`account-page page-container${entering ? ' page-enter' : ''}`}
        aria-busy="true"
      >
        <AccountHeading t={t} />
        <AccountPageSkeleton t={t} />
      </main>
    );
  }

  return <AccountContent profile={profile} entering={entering} appear={sawSkeleton.current} />;
}

function AccountHeading({ t }: { t: Translate }) {
  return (
    <header className="page-heading">
      <div>
        <h2>{t('accountTitle')}</h2>
        <p>{t('accountSubtitle')}</p>
      </div>
    </header>
  );
}

/** Placeholder cards that mirror the profile/account card geometry (avatar,
 * two form fields, consent row, buttons, two detail rows), so the loaded
 * content replaces them without layout shift. */
function AccountPageSkeleton({ t }: { t: Translate }) {
  return (
    <div className="account-skeleton" role="status" aria-label={t('loading')}>
      <Card className="account-card profile-card" aria-hidden="true">
        <div className="profile-summary">
          <span className="skeleton skeleton-avatar" />
          <div>
            <span className="skeleton skeleton-line skeleton-line-lg" />
            <span className="skeleton skeleton-line" />
          </div>
        </div>
        <div className="account-form-grid">
          <div className="field skeleton-field-block">
            <span className="skeleton skeleton-line skeleton-line-sm" />
            <span className="skeleton skeleton-field" />
          </div>
          <div className="field skeleton-field-block">
            <span className="skeleton skeleton-line skeleton-line-sm" />
            <span className="skeleton skeleton-field" />
          </div>
        </div>
        <span className="skeleton skeleton-line skeleton-line-wide" />
        <span className="skeleton skeleton-button" />
      </Card>
      <Card className="account-card" aria-hidden="true">
        <span className="skeleton skeleton-line skeleton-line-lg" />
        <div className="account-details skeleton-details">
          <div>
            <span className="skeleton skeleton-line skeleton-line-sm" />
            <span className="skeleton skeleton-line" />
          </div>
          <div>
            <span className="skeleton skeleton-line skeleton-line-sm" />
            <span className="skeleton skeleton-line" />
          </div>
        </div>
        <span className="skeleton skeleton-button" />
      </Card>
    </div>
  );
}

function AccountContent({
  profile,
  entering,
  appear
}: {
  profile: Profile;
  entering: boolean;
  appear: boolean;
}) {
  const { updateProfile, signOut } = useAuth();
  const { agentVersion, agentChannel, releaseManifest, toolAvailable } = useAgent();
  const { language: currentLanguage, setLanguage, t } = useI18n();
  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [language, setFormLanguage] = useState<Language>(profile.language ?? currentLanguage);
  const [marketing, setMarketing] = useState(profile.marketing_consent ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState(false);

  const releaseStatus = installedReleaseStatus({
    manifest: releaseManifest?.manifest ?? null,
    installedVersion: agentVersion,
    installedChannel: agentChannel,
    compatible: toolAvailable?.('compressor') ?? true
  });
  const downloadUrl = macAppleSiliconDownloadUrl(releaseManifest?.manifest ?? null);
  const releaseNote =
    releaseStatus === 'latest'
      ? t('latestVersion')
      : releaseStatus === 'update_available'
        ? t('updateAvailable')
        : releaseStatus === 'update_required'
          ? t('agentUpdateRequired')
          : releaseStatus === 'development'
            ? t('developmentVersion')
            : releaseStatus === 'newer'
              ? t('newerVersion')
              : t('versionCheckUnavailable');

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
    <main className={`account-page page-container${entering ? ' page-enter' : ''}`}>
      <AccountHeading t={t} />

      <div className={`account-loaded${appear ? ' content-appear' : ''}`}>
        <Card className="account-card profile-card" aria-labelledby="profile-heading">
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
          {formError && <div className="inline-alert inline-alert-error">{t('profileError')}</div>}
          {saved && <div className="inline-alert inline-alert-success">{t('changesSaved')}</div>}
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {t('saveChanges')}
          </Button>
        </Card>

        <Card className="account-card" aria-labelledby="account-details-heading">
          <h3 id="account-details-heading">{t('account')}</h3>
          <dl className="account-details">
            <Detail label={t('email')} value={profile.email ?? t('notAvailable')} />
            <div className="account-version-detail">
              <dt>{t('localAppVersion')}</dt>
              <dd>
                {agentVersion ?? t('notAvailable')}
                <span className="agent-version-note"> ({releaseNote})</span>
                {['update_available', 'update_required'].includes(releaseStatus) && (
                  <span className="agent-version-note">
                    {' · '}
                    <a href={downloadUrl}>{t('updateWishly')}</a>
                  </span>
                )}
              </dd>
            </div>
          </dl>
          <Button onClick={() => void signOut()}>{t('signOut')}</Button>
        </Card>
      </div>
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
