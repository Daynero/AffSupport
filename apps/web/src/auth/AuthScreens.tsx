import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { publicConfig } from '../lib/config';
import { clearReturnPath, safeReturnPath, takeReturnPath } from '../lib/redirects';
import { internalLink, navigateTo } from '../lib/navigation';
import { useI18n } from '../i18n';
import { Button, Checkbox, WishlyLoader } from '../components/ui';
import { WishlyLogo, WishlyMark } from '../components/WishlyLogo';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { analytics } from '../analytics/service';

export function AuthLoadingScreen({ callback = false }: { callback?: boolean }) {
  const { t } = useI18n();
  return (
    <main className="auth-state-screen" role="status" aria-live="polite">
      <div className="auth-state-brand">
        <WishlyMark size={34} />
        <WishlyLoader size={26} />
      </div>
      <p>{t(callback ? 'callbackWorking' : 'authChecking')}</p>
    </main>
  );
}

export function ConfigErrorScreen() {
  const { t } = useI18n();
  return (
    <main className="auth-state-screen auth-error-screen">
      <WishlyMark size={42} />
      <h1>{t('authConfigTitle')}</h1>
      <p>{t('authConfigBody')}</p>
      {!publicConfig.ok && (
        <ul>
          {publicConfig.errors.map(error => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <small>{t('authConfigHint')}</small>
    </main>
  );
}

function queryErrorMessage(t: ReturnType<typeof useI18n>['t']) {
  const code = new URLSearchParams(location.search).get('error');
  if (!code) return null;
  return t(code === 'access_denied' || code === 'cancelled' ? 'oauthCancelled' : 'callbackError');
}

export function LoginPage() {
  const { status, error, signInWithGoogle } = useAuth();
  const { t } = useI18n();
  const returnPath = safeReturnPath(new URLSearchParams(location.search).get('returnTo'));
  const queryError = queryErrorMessage(t);

  useEffect(() => {
    document.title = `${t('loginHeading')} — Wishly`;
  }, [t]);

  useEffect(() => {
    if (status === 'authenticated') navigateTo('/', true);
  }, [status]);

  if (status === 'initializing' || status === 'signing-out' || status === 'authenticated')
    return <AuthLoadingScreen />;
  if (!publicConfig.ok || error === 'configuration') return <ConfigErrorScreen />;

  const message =
    queryError ||
    (error === 'oauth'
      ? t('oauthError')
      : error === 'network'
        ? t('authNetworkError')
        : error === 'callback'
          ? t('callbackError')
          : null);
  const authenticating = status === 'authenticating';

  return (
    <main className="login-page">
      <div className="login-accent accent-one" aria-hidden="true" />
      <div className="login-accent accent-two" aria-hidden="true" />
      <header className="login-topbar">
        <WishlyLogo name="Wishly" />
        <LanguageSwitch />
      </header>
      <section className="login-card" aria-labelledby="login-heading">
        <span className="login-mark" aria-hidden="true">
          <WishlyMark size={44} />
        </span>
        <div className="login-copy">
          <h1 id="login-heading">{t('loginHeading')}</h1>
          <p>{t('loginDescription')}</p>
        </div>
        <p className="login-pitch">{t('loginSupportPitch')}</p>
        {message && (
          <div className="inline-alert inline-alert-error" role="alert">
            {message}
          </div>
        )}
        <button
          type="button"
          className={`google-sign-in ${authenticating ? 'is-loading' : ''}`}
          disabled={authenticating}
          onClick={() => void signInWithGoogle(returnPath)}
        >
          <span className="google-logo-crop" aria-hidden="true">
            <img src="/google-sign-in.svg" alt="" width="40" height="40" />
          </span>
          <span>{authenticating ? t('oauthLoading') : t('continueGoogle')}</span>
          {authenticating && (
            <span className="google-button-loader" aria-hidden="true">
              <WishlyLoader size={20} />
            </span>
          )}
        </button>
        <p className="login-legal">
          {t('loginFooterPrefix')}
          <a href="/terms" onClick={event => internalLink(event, '/terms')}>
            {t('termsAgreementLink')}
          </a>
          {t('loginFooterJoin')}
          <a href="/privacy" onClick={event => internalLink(event, '/privacy')}>
            {t('privacyAgreementLink')}
          </a>
          .
        </p>
      </section>
    </main>
  );
}

const callbackExchanges = new Map<string, Promise<void>>();

export function exchangeOAuthCodeOnce(code: string, exchange: (code: string) => Promise<void>) {
  const existing = callbackExchanges.get(code);
  if (existing) return existing;
  const pending = exchange(code);
  callbackExchanges.set(code, pending);
  return pending;
}

export function AuthCallbackPage() {
  const { completeOAuthCallback } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(location.search);
    const providerError = params.get('error');
    const code = params.get('code');
    if (providerError || !code) {
      clearReturnPath();
      navigateTo(
        `/login?error=${providerError === 'access_denied' ? 'access_denied' : 'callback'}`,
        true
      );
      return;
    }
    void exchangeOAuthCodeOnce(code, completeOAuthCallback)
      .then(() => navigateTo(takeReturnPath(), true))
      .catch(() => {
        clearReturnPath();
        navigateTo('/login?error=callback', true);
      });
  }, [completeOAuthCallback]);

  return <AuthLoadingScreen callback />;
}

export function AuthRecoveryScreen() {
  const { error, refreshProfile, signOut } = useAuth();
  const { t } = useI18n();
  const message =
    error === 'network'
      ? t('authNetworkError')
      : error === 'session'
        ? t('sessionExpired')
        : error === 'signout'
          ? t('signOutError')
          : t('profileError');
  return (
    <main className="auth-state-screen auth-error-screen">
      <WishlyMark size={42} />
      <h1>{message}</h1>
      <div className="inline-actions">
        {error !== 'session' && (
          <Button variant="primary" onClick={() => void refreshProfile()}>
            {t('retry')}
          </Button>
        )}
        <Button onClick={() => void signOut()}>{t('signOut')}</Button>
      </div>
    </main>
  );
}

export function BlockedAccountScreen({ deleted = false }: { deleted?: boolean }) {
  const { signOut, status } = useAuth();
  const { t } = useI18n();
  return (
    <main className="auth-state-screen auth-error-screen blocked-screen">
      <WishlyMark size={42} />
      <h1>{t(deleted ? 'deletedAccountTitle' : 'blockedAccountTitle')}</h1>
      <p>{t(deleted ? 'deletedAccountBody' : 'blockedAccountBody')}</p>
      <Button variant="primary" loading={status === 'signing-out'} onClick={() => void signOut()}>
        {t('signOut')}
      </Button>
    </main>
  );
}

export function ProfileOnboarding() {
  const { profile, updateProfile } = useAuth();
  const { language, setLanguage, t } = useI18n();
  const [marketing, setMarketing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => dialog.current?.querySelector<HTMLButtonElement>('.button-primary')?.focus(), []);
  if (!profile || profile.onboarding_completed) return null;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await updateProfile({
        language,
        marketing_consent: marketing,
        onboarding_completed: true
      });
      if (marketing !== profile.marketing_consent)
        analytics.track('marketing_consent_changed', { marketing_consent: marketing });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <WishlyMark size={40} />
        <div>
          <h2 id={titleId}>{t('welcomeTitle')}</h2>
          <p>{t('welcomeBody')}</p>
        </div>
        <fieldset>
          <legend>{t('chooseLanguage')}</legend>
          <div className="onboarding-language-options">
            <button
              type="button"
              className={language === 'uk' ? 'is-active' : ''}
              onClick={() => setLanguage('uk')}
              aria-pressed={language === 'uk'}
            >
              Українська
            </button>
            <button
              type="button"
              className={language === 'en' ? 'is-active' : ''}
              onClick={() => setLanguage('en')}
              aria-pressed={language === 'en'}
            >
              English
            </button>
          </div>
        </fieldset>
        <div className="onboarding-consent">
          <Checkbox
            checked={marketing}
            onChange={event => setMarketing(event.target.checked)}
            label={t('marketingConsent')}
          />
          <small>{t('marketingOptional')}</small>
        </div>
        {failed && <div className="inline-alert inline-alert-error">{t('profileError')}</div>}
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {saving ? t('saving') : t('continueWishly')}
        </Button>
      </section>
    </div>
  );
}
