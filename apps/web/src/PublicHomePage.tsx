import { useEffect } from 'react';
import { LanguageSwitch } from './components/LanguageSwitch';
import { PublicAmbientLabels } from './components/PublicAmbientLabels';
import { SotyLogo } from './components/SotyLogo';
import { ThemeToggle } from './components/ThemeToggle';
import { useI18n } from './i18n';
import { internalLink } from './lib/navigation';

export default function PublicHomePage() {
  const { t } = useI18n();

  useEffect(() => {
    document.title = 'Soty — Free local media tools';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('publicHomeDescription'));
  }, [t]);

  return (
    <div className="public-home">
      <div className="login-accent accent-one" aria-hidden="true" />
      <div className="login-accent accent-two" aria-hidden="true" />
      <PublicAmbientLabels />
      <header className="login-topbar public-topbar">
        <div className="topbar-cluster">
          <ThemeToggle />
          <LanguageSwitch />
        </div>
      </header>

      <main className="public-home-content">
        <section className="public-hero" aria-labelledby="public-home-title">
          <div className="public-hero-brand">
            <div className="public-hero-logo" aria-hidden="true">
              <SotyLogo name="Soty" />
            </div>
            <p className="public-eyebrow">{t('publicHomeEyebrow')}</p>
          </div>
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
