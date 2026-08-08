import { useEffect } from 'react';
import { LanguageSwitch } from './components/LanguageSwitch';
import { ThemeToggle } from './components/ThemeToggle';
import { WishlyLogo, WishlyMark } from './components/WishlyLogo';
import { useI18n } from './i18n';
import { internalLink } from './lib/navigation';

export default function PublicHomePage() {
  const { t } = useI18n();

  useEffect(() => {
    document.title = 'Soty — Local media tools and team workspace';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('publicHomeDescription'));
  }, [t]);

  return (
    <div className="public-home">
      <div className="login-accent accent-one" aria-hidden="true" />
      <div className="login-accent accent-two" aria-hidden="true" />
      <header className="login-topbar public-topbar">
        <a href="/" onClick={event => internalLink(event, '/')} aria-label="Soty">
          <WishlyLogo name="Soty" />
        </a>
        <div className="topbar-cluster">
          <ThemeToggle />
          <LanguageSwitch />
        </div>
      </header>

      <main className="public-home-content">
        <section className="public-hero" aria-labelledby="public-home-title">
          <div className="public-hero-mark" aria-hidden="true">
            <WishlyMark size={54} />
          </div>
          <p className="public-eyebrow">{t('publicHomeEyebrow')}</p>
          <h1 id="public-home-title">{t('publicHomeTitle')}</h1>
          <p className="public-hero-copy">{t('publicHomeDescription')}</p>
          <div className="public-home-actions">
            <a
              className="button button-primary"
              href="/login"
              onClick={event => internalLink(event, '/login')}
            >
              {t('publicHomeSignIn')}
            </a>
            <a className="button" href="#google-drive">
              {t('publicHomeLearnMore')}
            </a>
          </div>
        </section>

        <section className="public-feature-grid" aria-label={t('publicHomeCapabilities')}>
          <article>
            <span className="public-feature-number" aria-hidden="true">
              01
            </span>
            <h2>{t('publicHomeLocalTitle')}</h2>
            <p>{t('publicHomeLocalBody')}</p>
          </article>
          <article>
            <span className="public-feature-number" aria-hidden="true">
              02
            </span>
            <h2>{t('publicHomeTeamTitle')}</h2>
            <p>{t('publicHomeTeamBody')}</p>
          </article>
          <article>
            <span className="public-feature-number" aria-hidden="true">
              03
            </span>
            <h2>{t('publicHomePrivacyTitle')}</h2>
            <p>{t('publicHomePrivacyBody')}</p>
          </article>
        </section>

        <section id="google-drive" className="public-drive-section">
          <div>
            <p className="public-eyebrow">Google Drive</p>
            <h2>{t('publicHomeDriveTitle')}</h2>
          </div>
          <div className="public-drive-copy">
            <p>{t('publicHomeDriveBody')}</p>
            <p>{t('publicHomeDriveControl')}</p>
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <span>{t('publicHomeFooter')}</span>
        <nav aria-label="Legal">
          <a href="/privacy" onClick={event => internalLink(event, '/privacy')}>
            {t('privacyLink')}
          </a>
          <a href="/terms" onClick={event => internalLink(event, '/terms')}>
            {t('termsLink')}
          </a>
        </nav>
      </footer>
    </div>
  );
}
