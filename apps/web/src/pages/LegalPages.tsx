import { useEffect } from 'react';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { ThemeToggle } from '../components/ThemeToggle';
import { SotyLogo } from '../components/SotyLogo';
import { useI18n } from '../i18n';
import { privacy, terms } from './legal-content';
import { internalLink } from '../lib/navigation';
import { supportEmail } from '../lib/support';

export function PrivacyPage() {
  return <LegalPage kind="privacy" />;
}

export function TermsPage() {
  return <LegalPage kind="terms" />;
}

function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { language, t } = useI18n();
  const title = t(kind === 'privacy' ? 'privacyTitle' : 'termsTitle');
  const sections = (kind === 'privacy' ? privacy : terms)[language];

  useEffect(() => {
    document.title = `${title} — Soty`;
  }, [title]);

  // In-app links arrive without a document load, so the browser never jumps to
  // the fragment itself (the homepage links to #google-drive).
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <div className="legal-page">
      <header className="legal-topbar">
        <a href="/" onClick={event => internalLink(event, '/')} aria-label={t('backToSoty')}>
          <SotyLogo name="Soty" />
        </a>
        <div className="topbar-cluster">
          <ThemeToggle />
          <LanguageSwitch />
        </div>
      </header>
      <main className="legal-content">
        <header>
          <h1>{title}</h1>
          <p className="prose">{t('lastUpdated')}</p>
        </header>
        {sections.map(section => (
          <section key={section.heading} id={section.id}>
            <h2>{section.heading}</h2>
            {section.paragraphs.map(paragraph => (
              <p key={paragraph} className="prose">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
        <section className="legal-contact">
          <dl>
            <div>
              <dt>{language === 'uk' ? 'Контакт' : 'Contact'}</dt>
              <dd>
                <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
              </dd>
            </div>
          </dl>
        </section>
        <nav className="legal-nav" aria-label="Legal">
          <a href="/privacy" onClick={event => internalLink(event, '/privacy')}>
            {t('privacyLink')}
          </a>
          <a href="/terms" onClick={event => internalLink(event, '/terms')}>
            {t('termsLink')}
          </a>
          <a href="/" onClick={event => internalLink(event, '/')}>
            {t('backToSoty')}
          </a>
        </nav>
      </main>
    </div>
  );
}
