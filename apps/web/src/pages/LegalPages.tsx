import { useEffect } from 'react';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { WishlyLogo } from '../components/WishlyLogo';
import { useI18n, type Language } from '../i18n';
import { internalLink } from '../lib/navigation';
import { supportEmail } from '../lib/support';

type LegalSection = { heading: string; paragraphs: string[]; bullets?: string[] };

const privacy: Record<Language, LegalSection[]> = {
  en: [
    {
      heading: 'What Wishly stores',
      paragraphs: [
        'Wishly uses Google Login through Supabase Auth. We store your Supabase user ID, email, display name, avatar URL, account and activity timestamps, language, plan, account status, onboarding choice and optional marketing consent.',
        'Wishly does not create or store a Google password. Google access tokens and refresh tokens are not copied into Wishly product tables.'
      ]
    },
    {
      heading: 'Local media processing',
      paragraphs: [
        'Videos and selected images are processed on your computer by Wishly Agent. Media files, thumbnails and image contents are not uploaded to the server.',
        'Wishly product analytics do not include filenames, local paths, FFmpeg commands with paths, transcription text or media contents.'
      ]
    },
    {
      heading: 'Limited product analytics',
      paragraphs: [
        'Wishly records a small set of first-party events in Supabase to understand sign-ins, tool use, agent connectivity and aggregate compression outcomes. Examples include video counts, aggregate byte sizes, savings percentage, broad settings, duration, success category, app version, agent version, language and broad platform.',
        'Wishly does not add Google Analytics, advertising pixels, manual IP collection, device fingerprints or third-party marketing trackers at this stage.'
      ]
    },
    {
      heading: 'Marketing choice',
      paragraphs: [
        'Google Login is not marketing consent. The news checkbox is off by default, is never required to use Wishly and can be changed on the Account page. Wishly does not send marketing email at this stage.'
      ]
    },
    {
      heading: 'Your choices and deletion',
      paragraphs: [
        'You can change your name, language and marketing choice on the Account page. To permanently delete your account, contact Wishly support at the email below.',
        'Deleting the account removes the Auth user and profile. Product events may be retained only after their user ID is removed, so they can no longer be tied to the deleted account.'
      ]
    },
    {
      heading: 'Contact',
      paragraphs: ['For any privacy questions, contact Wishly support at the email below.']
    }
  ],
  uk: [
    {
      heading: 'Які дані зберігає Wishly',
      paragraphs: [
        'Wishly використовує Google Login через Supabase Auth. Ми зберігаємо ваш Supabase user ID, email, ім’я для відображення, URL аватара, час створення й активності, мову, план, статус акаунта, вибір onboarding та необов’язкову маркетингову згоду.',
        'Wishly не створює і не зберігає пароль Google. Google access token та refresh token не копіюються в продуктові таблиці Wishly.'
      ]
    },
    {
      heading: 'Локальна обробка медіа',
      paragraphs: [
        'Відео й вибрані зображення обробляються на вашому комп’ютері через Wishly Agent. Медіафайли, thumbnails і вміст зображень не завантажуються на сервер.',
        'Продуктова аналітика Wishly не містить назв файлів, локальних шляхів, FFmpeg-команд зі шляхами, тексту транскрипцій або вмісту медіа.'
      ]
    },
    {
      heading: 'Обмежена продуктова аналітика',
      paragraphs: [
        'Wishly записує невеликий набір first-party подій у Supabase, щоб розуміти входи, використання інструментів, підключення агента та агреговані результати стиснення. Це може бути кількість відео, сумарні розміри в байтах, відсоток економії, загальні налаштування, тривалість, категорія результату, версії застосунку й агента, мова та широка категорія платформи.',
        'На цьому етапі Wishly не додає Google Analytics, рекламні pixels, ручний збір IP, device fingerprint чи сторонні маркетингові trackers.'
      ]
    },
    {
      heading: 'Маркетингова згода',
      paragraphs: [
        'Google Login не є маркетинговою згодою. Галочка новин вимкнена за замовчуванням, не потрібна для роботи Wishly і змінюється на сторінці Акаунт. На цьому етапі Wishly не надсилає маркетингові листи.'
      ]
    },
    {
      heading: 'Ваш вибір і видалення',
      paragraphs: [
        'На сторінці Акаунт можна змінити ім’я, мову та маркетинговий вибір. Щоб назавжди видалити акаунт, напишіть у підтримку Wishly на пошту, вказану нижче.',
        'Видалення прибирає Auth user і профіль. Продуктові події можуть залишатися лише після видалення user ID, тому їх більше не можна пов’язати з видаленим акаунтом.'
      ]
    },
    {
      heading: 'Контакт',
      paragraphs: [
        'З будь-яких питань щодо приватності звертайтеся до підтримки Wishly на пошту, вказану нижче.'
      ]
    }
  ]
};

const terms: Record<Language, LegalSection[]> = {
  en: [
    {
      heading: 'The product',
      paragraphs: [
        'Wishly is provided as a tool for local media workflows. The current release is an MVP product and may change, be interrupted or contain defects.'
      ]
    },
    {
      heading: 'Your files and lawful use',
      paragraphs: [
        'You are responsible for the files you choose to process and for having the rights and permissions required to use them. You must not use Wishly for unlawful activity, infringement, abuse or harm.'
      ]
    },
    {
      heading: 'Local processing and results',
      paragraphs: [
        'Wishly Agent processes videos and images locally on your computer. Wishly does not upload those media files to the server.',
        'Compression output depends on the source files, codecs, system environment and settings you select. Estimates are not guarantees. Review completed output before relying on it and keep your originals until you are satisfied.'
      ]
    },
    {
      heading: 'Availability and responsibility',
      paragraphs: [
        'The MVP product is provided without a promise of uninterrupted availability or fitness for a specific purpose to the extent permitted by applicable law. Nothing in these terms excludes rights that cannot legally be excluded.'
      ]
    },
    {
      heading: 'Contact',
      paragraphs: [
        'For any questions about these terms, contact Wishly support at the email below.'
      ]
    }
  ],
  uk: [
    {
      heading: 'Продукт',
      paragraphs: [
        'Wishly надається як інструмент для локальної роботи з медіа. Поточна версія має статус MVP і може змінюватися, тимчасово не працювати або містити помилки.'
      ]
    },
    {
      heading: 'Ваші файли та законне використання',
      paragraphs: [
        'Ви відповідаєте за файли, які обираєте для обробки, та за наявність потрібних прав і дозволів. Заборонено використовувати Wishly для незаконної діяльності, порушення прав, зловживань або завдання шкоди.'
      ]
    },
    {
      heading: 'Локальна обробка та результати',
      paragraphs: [
        'Wishly Agent обробляє відео й зображення локально на вашому комп’ютері. Wishly не завантажує ці медіафайли на сервер.',
        'Результат стиснення залежить від вихідних файлів, кодеків, системного середовища й вибраних налаштувань. Оцінки не є гарантією. Перевіряйте готовий результат і зберігайте оригінали, доки не переконаєтеся в його якості.'
      ]
    },
    {
      heading: 'Доступність і відповідальність',
      paragraphs: [
        'MVP-продукт надається без обіцянки безперервної доступності чи придатності для конкретної мети в межах, дозволених законом. Ці умови не обмежують права, які не можуть бути законно обмежені.'
      ]
    },
    {
      heading: 'Контакт',
      paragraphs: [
        'З будь-яких питань щодо цих умов звертайтеся до підтримки Wishly на пошту, вказану нижче.'
      ]
    }
  ]
};

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
    document.title = `${title} — Wishly`;
  }, [title]);

  return (
    <div className="legal-page">
      <header className="legal-topbar">
        <a href="/" onClick={event => internalLink(event, '/')} aria-label={t('backToWishly')}>
          <WishlyLogo name="Wishly" />
        </a>
        <LanguageSwitch />
      </header>
      <main className="legal-content">
        <header>
          <h1>{title}</h1>
          <p>{t('lastUpdated')}</p>
        </header>
        {sections.map(section => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.paragraphs.map(paragraph => (
              <p key={paragraph}>{paragraph}</p>
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
            {t('backToWishly')}
          </a>
        </nav>
      </main>
    </div>
  );
}
