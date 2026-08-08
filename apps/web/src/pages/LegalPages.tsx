import { useEffect } from 'react';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { ThemeToggle } from '../components/ThemeToggle';
import { SotyLogo } from '../components/SotyLogo';
import { useI18n, type Language } from '../i18n';
import { internalLink } from '../lib/navigation';
import { supportEmail } from '../lib/support';

type LegalSection = { heading: string; paragraphs: string[]; bullets?: string[] };

const privacy: Record<Language, LegalSection[]> = {
  en: [
    {
      heading: 'What Soty stores',
      paragraphs: [
        'Soty uses Google Login through Supabase Auth. We store your Supabase user ID, email, display name, avatar URL, account and activity timestamps, language, plan, account status, onboarding choice and optional marketing consent.',
        'Soty does not create or store a Google password. Login tokens are handled by Supabase Auth and are separate from an optional Google Drive team-workspace connection.'
      ]
    },
    {
      heading: 'Google Drive team workspace',
      paragraphs: [
        'A team owner can optionally connect one Google Drive folder. Soty requests Google Drive access so it can browse the confirmed folder and its descendants and, when an authorized team member asks, list, preview, upload, download, edit, move, process, or move items to and from Google Drive Trash. Soty limits product actions to the confirmed team root and checks the member’s Soty permissions before every operation. Soty roles do not change permissions granted directly in Google Drive.',
        'The Google refresh token for a connected account is encrypted in Supabase Vault. Short-lived access tokens are used only by server-side Edge Functions. Google credentials are never sent to team members, the browser, Soty Agent, product analytics, or application logs. For an explicitly requested local workflow, Soty Agent receives only a short-lived, operation-specific file transfer grant and never a Google credential.',
        'Soty stores the connected account email and the file and folder metadata needed for the team catalog, such as Google Drive identifiers, names, types, parent relationships, sizes, timestamps, capabilities, sync state, and workflow history. Authorized team members can see catalog data and file content according to their Soty permissions. File contents remain in Google Drive and are relayed by Soty only for a requested preview, download, edit, upload, or processing operation.'
      ]
    },
    {
      heading: 'Google data sharing, retention and deletion',
      paragraphs: [
        'Soty uses Google user data only to provide the connected team-workspace features described above. It does not sell Google user data or use it for advertising. Soty’s use and transfer to any other app of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.',
        'A team owner can disconnect or replace the Google Drive folder. Disconnecting removes the stored Google credential when it is no longer used by another active connection and does not delete files from Google Drive. Cached catalog metadata, provenance, and audit records can remain after disconnect to preserve team history and recoverability. Contact Soty support to request deletion of this retained team data, subject to security or legal retention obligations.',
        'When Soty deletes a Drive item, it moves the item to Google Drive Trash rather than permanently erasing it. Google Drive’s own retention and direct user actions control final deletion and recovery.'
      ]
    },
    {
      heading: 'Local media processing',
      paragraphs: [
        'Videos and selected images are processed on your computer by Soty Agent. Media files, thumbnails and image contents are not uploaded to the server.',
        'Soty product analytics do not include filenames, local paths, FFmpeg commands with paths, transcription text or media contents.'
      ]
    },
    {
      heading: 'Limited product analytics',
      paragraphs: [
        'Soty records a small set of first-party events in Supabase to understand sign-ins, tool use, agent connectivity and aggregate compression outcomes. Examples include video counts, aggregate byte sizes, savings percentage, broad settings, duration, success category, app version, agent version, language and broad platform.',
        'Soty does not add Google Analytics, advertising pixels, manual IP collection, device fingerprints or third-party marketing trackers at this stage.'
      ]
    },
    {
      heading: 'Marketing choice',
      paragraphs: [
        'Google Login is not marketing consent. The news checkbox is off by default, is never required to use Soty and can be changed on the Account page. Soty does not send marketing email at this stage.'
      ]
    },
    {
      heading: 'Your choices and deletion',
      paragraphs: [
        'You can change your name, language and marketing choice on the Account page. To permanently delete your account, contact Soty support at the email below.',
        'Deleting the account removes the Auth user and profile. Product events may be retained only after their user ID is removed, so they can no longer be tied to the deleted account.'
      ]
    },
    {
      heading: 'Contact',
      paragraphs: ['For any privacy questions, contact Soty support at the email below.']
    }
  ],
  uk: [
    {
      heading: 'Які дані зберігає Soty',
      paragraphs: [
        'Soty використовує Google Login через Supabase Auth. Ми зберігаємо ваш Supabase user ID, email, ім’я для відображення, URL аватара, час створення й активності, мову, план, статус акаунта, вибір onboarding та необов’язкову маркетингову згоду.',
        'Soty не створює і не зберігає пароль Google. Токени входу обробляє Supabase Auth; вони не пов’язані з необов’язковим підключенням командного простору Google Drive.'
      ]
    },
    {
      heading: 'Командний простір Google Drive',
      paragraphs: [
        'Власник команди може за бажанням підключити одну папку Google Drive. Soty запитує доступ до Google Drive, щоб переглядати підтверджену папку та її вкладений вміст і, на явний запит уповноваженого учасника, показувати, завантажувати, скачувати, редагувати, переміщувати, обробляти файли або переносити їх до й із кошика Google Drive. Soty обмежує продуктові дії підтвердженим коренем команди й перед кожною операцією перевіряє дозволи учасника у Soty. Ролі Soty не змінюють дозволи, надані безпосередньо в Google Drive.',
        'Google refresh token підключеного акаунта зберігається зашифрованим у Supabase Vault. Короткочасні access tokens використовують лише серверні Edge Functions. Google credentials ніколи не передаються учасникам команди, браузеру, Soty Agent, продуктовій аналітиці чи журналам застосунку. Для явно запущеної локальної операції Soty Agent отримує лише короткочасний дозвіл на передачу конкретного файла й ніколи не отримує Google credential.',
        'Soty зберігає email підключеного акаунта та метадані файлів і папок, потрібні для командного каталогу: Google Drive identifiers, назви, типи, зв’язки з батьківськими папками, розміри, timestamps, capabilities, стан синхронізації й історію операцій. Уповноважені учасники бачать дані каталогу та вміст файлів відповідно до своїх дозволів Soty. Вміст файлів залишається в Google Drive і передається через Soty лише для запитаного preview, download, edit, upload або processing.'
      ]
    },
    {
      heading: 'Передавання, зберігання й видалення даних Google',
      paragraphs: [
        'Soty використовує дані користувача Google лише для описаних вище функцій командного простору. Soty не продає дані користувача Google і не використовує їх для реклами. Використання та передавання в інші застосунки інформації, отриманої Soty від Google APIs, відповідає Google API Services User Data Policy, зокрема вимогам Limited Use.',
        'Власник команди може від’єднати або замінити папку Google Drive. Від’єднання видаляє збережений Google credential, коли його більше не використовує інше активне підключення, і не видаляє файли з Google Drive. Кешовані метадані каталогу, provenance та audit records можуть залишатися після від’єднання для збереження історії команди й можливості відновлення. Щоб попросити про видалення цих командних даних, зверніться до підтримки Soty; можуть діяти обов’язкові строки зберігання для безпеки чи згідно із законом.',
        'Коли Soty видаляє об’єкт Drive, він переноситься до кошика Google Drive, а не стирається назавжди. Остаточне видалення й відновлення визначаються правилами Google Drive та прямими діями користувача.'
      ]
    },
    {
      heading: 'Локальна обробка медіа',
      paragraphs: [
        'Відео й вибрані зображення обробляються на вашому комп’ютері через Soty Agent. Медіафайли, thumbnails і вміст зображень не завантажуються на сервер.',
        'Продуктова аналітика Soty не містить назв файлів, локальних шляхів, FFmpeg-команд зі шляхами, тексту транскрипцій або вмісту медіа.'
      ]
    },
    {
      heading: 'Обмежена продуктова аналітика',
      paragraphs: [
        'Soty записує невеликий набір first-party подій у Supabase, щоб розуміти входи, використання інструментів, підключення агента та агреговані результати стиснення. Це може бути кількість відео, сумарні розміри в байтах, відсоток економії, загальні налаштування, тривалість, категорія результату, версії застосунку й агента, мова та широка категорія платформи.',
        'На цьому етапі Soty не додає Google Analytics, рекламні pixels, ручний збір IP, device fingerprint чи сторонні маркетингові trackers.'
      ]
    },
    {
      heading: 'Маркетингова згода',
      paragraphs: [
        'Google Login не є маркетинговою згодою. Галочка новин вимкнена за замовчуванням, не потрібна для роботи Soty і змінюється на сторінці Акаунт. На цьому етапі Soty не надсилає маркетингові листи.'
      ]
    },
    {
      heading: 'Ваш вибір і видалення',
      paragraphs: [
        'На сторінці Акаунт можна змінити ім’я, мову та маркетинговий вибір. Щоб назавжди видалити акаунт, напишіть у підтримку Soty на пошту, вказану нижче.',
        'Видалення прибирає Auth user і профіль. Продуктові події можуть залишатися лише після видалення user ID, тому їх більше не можна пов’язати з видаленим акаунтом.'
      ]
    },
    {
      heading: 'Контакт',
      paragraphs: [
        'З будь-яких питань щодо приватності звертайтеся до підтримки Soty на пошту, вказану нижче.'
      ]
    }
  ]
};

const terms: Record<Language, LegalSection[]> = {
  en: [
    {
      heading: 'The product',
      paragraphs: [
        'Soty is provided as a tool for local media workflows. The current release is an MVP product and may change, be interrupted or contain defects.'
      ]
    },
    {
      heading: 'Your files and lawful use',
      paragraphs: [
        'You are responsible for the files you choose to process and for having the rights and permissions required to use them. You must not use Soty for unlawful activity, infringement, abuse or harm.'
      ]
    },
    {
      heading: 'Local processing and results',
      paragraphs: [
        'Soty Agent processes videos and images locally on your computer. Soty does not upload those media files to the server.',
        'Compression output depends on the source files, codecs, system environment and settings you select. Estimates are not guarantees. Review completed output before relying on it and keep your originals until you are satisfied.'
      ]
    },
    {
      heading: 'Local TranslateGemma model',
      paragraphs: [
        'If you install local translation, TranslateGemma is provided under and subject to the Gemma Terms of Use at ai.google.dev/gemma/terms and the Gemma Prohibited Use Policy at ai.google.dev/gemma/prohibited_use_policy. Those restrictions apply to your use of the model and its outputs.',
        'Machine translations and semantic alignment confidence are estimates, not guarantees. Review important translations before relying on them.'
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
      paragraphs: ['For any questions about these terms, contact Soty support at the email below.']
    }
  ],
  uk: [
    {
      heading: 'Продукт',
      paragraphs: [
        'Soty надається як інструмент для локальної роботи з медіа. Поточна версія має статус MVP і може змінюватися, тимчасово не працювати або містити помилки.'
      ]
    },
    {
      heading: 'Ваші файли та законне використання',
      paragraphs: [
        'Ви відповідаєте за файли, які обираєте для обробки, та за наявність потрібних прав і дозволів. Заборонено використовувати Soty для незаконної діяльності, порушення прав, зловживань або завдання шкоди.'
      ]
    },
    {
      heading: 'Локальна обробка та результати',
      paragraphs: [
        'Soty Agent обробляє відео й зображення локально на вашому комп’ютері. Soty не завантажує ці медіафайли на сервер.',
        'Результат стиснення залежить від вихідних файлів, кодеків, системного середовища й вибраних налаштувань. Оцінки не є гарантією. Перевіряйте готовий результат і зберігайте оригінали, доки не переконаєтеся в його якості.'
      ]
    },
    {
      heading: 'Локальна модель TranslateGemma',
      paragraphs: [
        'Якщо ви встановлюєте локальний переклад, TranslateGemma надається відповідно до Gemma Terms of Use за адресою ai.google.dev/gemma/terms та Gemma Prohibited Use Policy за адресою ai.google.dev/gemma/prohibited_use_policy. Ці обмеження поширюються на використання моделі та її результатів.',
        'Машинний переклад і впевненість семантичного вирівнювання є оцінками, а не гарантіями. Перевіряйте важливі переклади перед використанням.'
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
        'З будь-яких питань щодо цих умов звертайтеся до підтримки Soty на пошту, вказану нижче.'
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
  // The legal copy predates the Soty rename. Keep the displayed brand identical
  // to the public homepage and OAuth consent-screen name; Google verification
  // rejects branding that does not match across these surfaces.
  const sections = (kind === 'privacy' ? privacy : terms)[language].map(section => ({
    ...section,
    heading: section.heading.replaceAll('Soty', 'Soty'),
    paragraphs: section.paragraphs.map(paragraph => paragraph.replaceAll('Soty', 'Soty'))
  }));

  useEffect(() => {
    document.title = `${title} — Soty`;
  }, [title]);

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
            {t('backToSoty')}
          </a>
        </nav>
      </main>
    </div>
  );
}
