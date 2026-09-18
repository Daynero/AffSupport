/**
 * The legal copy, kept free of React so the build can write it into static HTML
 * as well (vite-plugins/static-public-pages.ts): Google's verification expects
 * the Privacy Policy to be readable as HTML, not only after a script runs.
 */
import type { Language } from '../i18n';

export type LegalSection = {
  id?: string;
  heading: string;
  paragraphs: string[];
  bullets?: string[];
};

export const privacy: Record<Language, LegalSection[]> = {
  en: [
    {
      heading: 'What Soty stores',
      paragraphs: [
        'Soty uses Google Login through Supabase Auth. We store your Supabase user ID, email, display name, avatar URL, account and activity timestamps, language, plan, account status, onboarding choice and optional marketing consent.',
        'Soty does not create or store a Google password. Login tokens are handled by Supabase Auth and are separate from the optional Google Drive connection of a space.'
      ]
    },
    {
      id: 'google-drive',
      heading: 'Spaces on Google Drive',
      paragraphs: [
        'A space is where you keep your creatives, tasks and accounts, alone or with the people you invite. Its owner can optionally connect Google Drive to it. Soty asks Google only for the drive.file permission: access to the folders and files the owner selects in Google’s own folder chooser and to the files Soty creates. Soty does not request access to the rest of your Google Drive.',
        'Soty uses that access to keep the space’s catalog of the selected folders up to date and, when an authorized member of the space asks, to preview, download, upload, rename, copy or move files, create folders, create product catalogs as Google Sheets, and move items to and from Google Drive Trash. When a member shares a file by link or creates a product catalog, Soty turns on “anyone with the link can view” for that file — and, for a catalog, for the catalog sheet, its video and the pictures it uses, because the advertising platform the catalog is made for reads them by link. Soty limits these actions to the selected folders and checks the member’s Soty permissions before every operation. Soty roles do not change permissions granted directly in Google Drive.',
        'Some of this work continues while nobody has Soty open, and only for features a member of the space has turned on: Soty keeps the catalog of the selected folders in step with Google Drive; a catalog whose scheduled update is on is rewritten on that schedule, and a re-stitched copy of its video is made in a “Restitched” folder Soty creates inside the space’s folder, and the copy it replaces — a temporary file Soty made — is deleted; and when a video is deleted, the files Soty itself made from it — its transcript and its product catalogs — are moved to Google Drive Trash after a day, and its temporary re-stitched copies are deleted. Soty never deletes or moves to Trash on its own a file it did not create.',
        'The Google refresh token for a connected account is encrypted in Supabase Vault. Short-lived access tokens are used only by server-side Edge Functions. Google credentials are never sent to other members of a space, the browser, Soty Agent, product analytics, or application logs. For an explicitly requested local workflow, Soty Agent receives only a short-lived, operation-specific file transfer grant and never a Google credential.',
        'Soty stores the connected account email and the file and folder metadata needed for the space’s catalog, such as Google Drive identifiers, names, types, parent relationships, sizes, timestamps, capabilities, sync state, and workflow history. Authorized members of the space can see catalog data and file content according to their Soty permissions. File contents remain in Google Drive and are relayed by Soty only for a requested preview, download, edit, upload, or processing operation.'
      ]
    },
    {
      heading: 'Google data sharing, retention and deletion',
      paragraphs: [
        'Soty uses Google user data only to provide the space features described above. It does not sell Google user data, does not use it for advertising, and does not use it to develop, improve or train generalized artificial intelligence or machine learning models. People at Soty do not read Google user data except with your permission for support, for security reasons, or where the law requires it. Soty’s use and transfer to any other app of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.',
        'The owner of a space can disconnect or replace the Google Drive folder. Disconnecting removes the stored Google credential when it is no longer used by another active connection and does not delete files from Google Drive. Cached catalog metadata, provenance, and audit records can remain after disconnect to preserve the space’s history and recoverability. Contact Soty support to request deletion of this retained data, subject to security or legal retention obligations.',
        'When Soty deletes a Drive item, it moves the item to Google Drive Trash rather than permanently erasing it; Google Drive’s own retention and direct user actions control final deletion and recovery. The one exception is the temporary re-stitched copy of a video that Soty itself makes for a scheduled catalog update: when the next copy replaces it, the old one is deleted outright, because it is a working file nobody opens.'
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
        'Soty не створює і не зберігає пароль Google. Токени входу обробляє Supabase Auth; вони не пов’язані з необов’язковим підключенням Google Drive до простору.'
      ]
    },
    {
      id: 'google-drive',
      heading: 'Простори на Google Drive',
      paragraphs: [
        'Простір — це місце для ваших креативів, завдань і акаунтів, де ви працюєте самі або з людьми, яких запросили. Його власник може за бажанням підключити до нього Google Drive. Soty просить у Google лише дозвіл drive.file: доступ до папок і файлів, які власник вибирає у власному вікні вибору Google, та до файлів, створених Soty. Доступу до решти вашого Google Drive Soty не запитує.',
        'Soty використовує цей доступ, щоб підтримувати каталог вибраних папок в актуальному стані, а на запит уповноваженого учасника простору — показувати, скачувати, завантажувати, перейменовувати, копіювати й переміщувати файли, створювати папки, створювати каталоги товарів як Google-таблиці та переносити об’єкти до кошика Google Drive і назад. Коли учасник ділиться файлом за посиланням або створює каталог товарів, Soty вмикає для цього файла доступ «усі, хто має посилання, можуть переглядати» — а для каталогу також для самої таблиці, її відео та картинок, які вона використовує, бо рекламна платформа, для якої зроблено каталог, читає їх за посиланням. Soty обмежує ці дії вибраними папками й перед кожною операцією перевіряє дозволи учасника у Soty. Ролі Soty не змінюють дозволи, надані безпосередньо в Google Drive.',
        'Частина цієї роботи триває й тоді, коли Soty ні в кого не відкритий, і лише для функцій, які увімкнув учасник простору: Soty тримає каталог вибраних папок у відповідності з Google Drive; каталог товарів з увімкненим оновленням за розкладом переписується за цим розкладом, а перезашита копія його відео створюється в папці «Restitched», яку Soty створює всередині папки простору, а копія, яку вона замінює, — тимчасовий файл, зроблений самим Soty, — видаляється; а коли відео видалено, файли, які Soty сам зробив із нього — транскрипт і каталоги товарів, — через добу переносяться до кошика Google Drive, а тимчасові перезашиті копії видаляються. Файл, який Soty не створював, він сам ніколи не видаляє й не переносить до кошика.',
        'Google refresh token підключеного акаунта зберігається зашифрованим у Supabase Vault. Короткочасні access tokens використовують лише серверні Edge Functions. Google credentials ніколи не передаються іншим учасникам простору, браузеру, Soty Agent, продуктовій аналітиці чи журналам застосунку. Для явно запущеної локальної операції Soty Agent отримує лише короткочасний дозвіл на передачу конкретного файла й ніколи не отримує Google credential.',
        'Soty зберігає email підключеного акаунта та метадані файлів і папок, потрібні для каталогу простору: Google Drive identifiers, назви, типи, зв’язки з батьківськими папками, розміри, timestamps, capabilities, стан синхронізації й історію операцій. Уповноважені учасники простору бачать дані каталогу та вміст файлів відповідно до своїх дозволів Soty. Вміст файлів залишається в Google Drive і передається через Soty лише для запитаного preview, download, edit, upload або processing.'
      ]
    },
    {
      heading: 'Передавання, зберігання й видалення даних Google',
      paragraphs: [
        'Soty використовує дані користувача Google лише для описаних вище функцій просторів. Soty не продає дані користувача Google, не використовує їх для реклами й не використовує для розробки, покращення чи навчання узагальнених моделей штучного інтелекту або машинного навчання. Люди в Soty не читають дані користувача Google, окрім як з вашого дозволу для підтримки, з міркувань безпеки або коли цього вимагає закон. Використання та передавання в інші застосунки інформації, отриманої Soty від Google APIs, відповідає Google API Services User Data Policy, зокрема вимогам Limited Use.',
        'Власник простору може від’єднати або замінити папку Google Drive. Від’єднання видаляє збережений Google credential, коли його більше не використовує інше активне підключення, і не видаляє файли з Google Drive. Кешовані метадані каталогу, provenance та audit records можуть залишатися після від’єднання для збереження історії простору й можливості відновлення. Щоб попросити про видалення цих даних, зверніться до підтримки Soty; можуть діяти обов’язкові строки зберігання для безпеки чи згідно із законом.',
        'Коли Soty видаляє об’єкт Drive, він переноситься до кошика Google Drive, а не стирається назавжди; остаточне видалення й відновлення визначаються правилами Google Drive та прямими діями користувача. Єдиний виняток — тимчасова перезашита копія відео, яку Soty сам робить для оновлення каталогу за розкладом: коли її замінює наступна копія, стара видаляється одразу, бо це робочий файл, який ніхто не відкриває.'
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

export const terms: Record<Language, LegalSection[]> = {
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
