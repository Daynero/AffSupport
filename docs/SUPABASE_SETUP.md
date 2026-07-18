# Налаштування Supabase і Google Login для Wishly

Цей файл розрахований на перше налаштування без попереднього досвіду. У коді вже є авторизація, таблиці, RLS, аналітика, адмінка й видалення акаунта. Реальні ключі в репозиторій додавати не потрібно.

> Ніколи не вставляйте Google Client Secret, Supabase secret key або `service_role` у `.env`, GitHub, Cloudflare Pages чи чат. Google Client Secret вводиться тільки в Supabase Dashboard.

## Адреси цієї реалізації

| Призначення           | Development                           | Production                                   |
| --------------------- | ------------------------------------- | -------------------------------------------- |
| Wishly origin         | `http://127.0.0.1:5173`               | `https://wishly-app.pages.dev`               |
| Wishly OAuth callback | `http://127.0.0.1:5173/auth/callback` | `https://wishly-app.pages.dev/auth/callback` |
| Privacy Policy        | `http://127.0.0.1:5173/privacy`       | `https://wishly-app.pages.dev/privacy`       |
| Terms of Use          | `http://127.0.0.1:5173/terms`         | `https://wishly-app.pages.dev/terms`         |

Якщо production-домен зміниться, спочатку оновіть єдине джерело адреси в `packages/shared/src/release.ts`, синхронний `PUBLIC_SITE_ORIGIN` у `config/production.env`, а потім усі production-адреси в Supabase, Google Cloud і хостингу.

## 1. Скопіюйте дані проєкту із Supabase

1. Відкрийте [Supabase Dashboard](https://supabase.com/dashboard) і виберіть створений проєкт.
2. Натисніть **Connect** у верхній частині сторінки. Якщо кнопки немає, відкрийте **Project Settings → API Keys**.
3. Скопіюйте **Project URL**. Він має вигляд `https://PROJECT_REF.supabase.co`.
4. Скопіюйте **Publishable key**, який починається з `sb_publishable_`. Якщо Dashboard показує лише старий `anon` key, він також працює, але не використовуйте `service_role` або secret key.
5. У корені репозиторію скопіюйте `.env.example` у `.env`.
6. Заповніть тільки значення:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
VITE_SITE_URL=http://127.0.0.1:5173
VITE_ADMIN_EMAIL=
VITE_PRODUCT_OPERATOR=ІМʼЯ_АБО_НАЗВА_ОПЕРАТОРА
VITE_LEGAL_CONTACT_EMAIL=CONTACT_EMAIL
VITE_DELETE_ACCOUNT_ENABLED=false
VITE_AGENT_URL=http://127.0.0.1:43120
```

`.env` уже виключений з Git. `VITE_ADMIN_EMAIL` — лише необов’язкова підказка для розробки й не надає прав адміністратора.

## 2. Застосуйте SQL migrations

Найпростіший відтворюваний спосіб — Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

`YOUR_PROJECT_REF` — частина Project URL перед `.supabase.co`; це не ключ і не пароль. Під час `supabase login` відкриється браузер.

Якщо CLI використати неможливо:

1. У Supabase відкрийте **SQL Editor → New query**.
2. По черзі відкрийте та виконайте вміст цих файлів:
   1. `supabase/migrations/20260718210000_profiles_and_admin.sql`;
   2. `supabase/migrations/20260718211000_analytics.sql`;
   3. `supabase/migrations/20260718212000_admin_functions.sql`.
3. Не змінюйте порядок.

Перевірка після migration:

1. Відкрийте **Table Editor**.
2. Переконайтеся, що є `profiles`, `admin_users` і `analytics_events`.
3. Для кожної таблиці у властивостях має бути ввімкнено RLS.
4. До першого входу `profiles` і `analytics_events` будуть порожніми — це нормально.

Rollback-пояснення є в `supabase/migrations/ROLLBACK.md`. Для production спочатку робіть backup; rollback видаляє дані.

## 3. Налаштуйте адреси в Supabase Auth

1. У Supabase відкрийте **Authentication → URL Configuration**.
2. У **Site URL** для поточного production-проєкту введіть:

```text
https://wishly-app.pages.dev
```

3. У **Redirect URLs** додайте обидві точні адреси:

```text
http://127.0.0.1:5173/auth/callback
https://wishly-app.pages.dev/auth/callback
```

4. Не використовуйте широкий wildcard для production, якщо він не потрібен. Preview-домен додавайте окремим точним callback URL.

Site URL — fallback Supabase. Код Wishly завжди передає конкретний `<VITE_SITE_URL>/auth/callback` і приймає return path лише з внутрішнього allowlist.

## 4. Створіть Google OAuth client

1. Відкрийте [Google Cloud Console](https://console.cloud.google.com/) і створіть або виберіть project для Wishly.
2. Відкрийте **Google Auth Platform → Branding**.
3. Вкажіть назву **Wishly**, support email і developer contact email.
4. Для production додайте:
   - Homepage: `https://wishly-app.pages.dev`;
   - Privacy Policy: `https://wishly-app.pages.dev/privacy`;
   - Terms of Use: `https://wishly-app.pages.dev/terms`.
5. Не вигадуйте юридичну особу. Перед публічним запуском заповніть `VITE_PRODUCT_OPERATOR` і `VITE_LEGAL_CONTACT_EMAIL` реальними даними та перевірте legal-тексти.
6. Відкрийте **Audience**:
   - для звичайних Google-акаунтів виберіть **External**;
   - під час тестування залиште статус **Testing** і додайте email тестувальників у **Test users**;
   - якщо проєкт належить Google Workspace і Wishly потрібен лише всередині організації, можна вибрати **Internal**.
     У режимі Testing увійти можуть лише додані test users (до 100). Google показує їм тестове попередження, а дозвіл може закінчуватися через 7 днів, тому повторний consent під час тестування є нормальним.
7. Відкрийте **Data Access** і залиште тільки базові scopes:
   - `openid`;
   - `.../auth/userinfo.email`;
   - `.../auth/userinfo.profile`.
8. Не додавайте Drive, Gmail, Calendar, Contacts або інші Google API scopes.
9. Відкрийте **Clients → Create client → Web application**.
10. У **Authorized JavaScript origins** додайте:

```text
http://127.0.0.1:5173
https://wishly-app.pages.dev
```

11. Тепер у сусідній вкладці відкрийте Supabase **Authentication → Sign In / Providers → Google**.
12. Скопіюйте звідти точний **Callback URL (for OAuth)**. Він зазвичай має форму:

```text
https://PROJECT_REF.supabase.co/auth/v1/callback
```

13. Поверніться в Google client і вставте цю адресу в **Authorized redirect URIs**. Не вставляйте сюди `/auth/callback` Wishly: Google спочатку повертає користувача в Supabase.
14. Створіть client і одразу скопіюйте **Client ID** та **Client Secret**. Google може показати secret лише один раз.

Для публічної Google Branding verification зазвичай потрібен домен, яким ви реально володієте й який можете підтвердити в Google Search Console. `wishly-app.pages.dev` достатній для технічного тесту, але перед широким production launch краще підключити власний Wishly-домен і оновити адреси за checklist у `PRODUCTION.md`.

Документація: [Supabase Google Login](https://supabase.com/docs/guides/auth/social-login/auth-google), [Google OAuth Clients](https://support.google.com/cloud/answer/15549257).

## 5. Увімкніть Google provider у Supabase

1. У Supabase відкрийте **Authentication → Sign In / Providers → Google**.
2. Увімкніть provider.
3. Вставте **Google Client ID**.
4. Вставте **Google Client Secret**.
5. Натисніть **Save**.

Client Secret залишається в Supabase. Не копіюйте його в `.env`, frontend, Cloudflare Pages або репозиторій.

## 6. Запустіть Wishly і перевірте перший вхід

```bash
npm install
npm run dev
```

1. Відкрийте `http://127.0.0.1:5173`.
2. Натисніть **Продовжити з Google**.
3. Після входу має відкритися Wishly, а не залишитися `/auth/callback`.
4. Оновіть сторінку: сесія має зберегтися.
5. Відкрийте напряму `http://127.0.0.1:5173/compressor`: маршрут має працювати.
6. У Supabase відкрийте **Authentication → Users** — там зʼявиться користувач.
7. У **Table Editor → profiles** перевірте автоматично створений профіль.
8. Відкрийте компресор або іншу сторінку, а потім **Table Editor → analytics_events**. Там будуть тільки агреговані продуктні події без назв файлів і локальних шляхів.

Якщо Google показує `redirect_uri_mismatch`, порівняйте Google Authorized redirect URI з callback, який показує Supabase Google provider, символ у символ.

## 7. Додайте першого адміністратора

Email або `VITE_ADMIN_EMAIL` не надає адмін-доступ. Потрібен UUID із Supabase:

1. Спочатку увійдіть у Wishly через Google.
2. У Supabase відкрийте **Authentication → Users**.
3. Відкрийте свій рядок і скопіюйте **User UID**.
4. Відкрийте **SQL Editor → New query**.
5. Вставте команду, замінивши лише placeholder власним UUID:

```sql
insert into public.admin_users (user_id)
values ('PASTE-YOUR-USER-UUID-HERE')
on conflict (user_id) do nothing;
```

6. Виконайте query, перезавантажте Wishly і відкрийте `/admin`.

Звичайні користувачі не можуть читати `admin_users`, додавати себе або викликати admin aggregates: це перевіряється RLS і database functions.

## 8. Розгорніть безпечне видалення акаунта

До deployment функції кнопка видалення навмисно вимкнена.

```bash
npx supabase secrets set WISHLY_SITE_URL=https://wishly-app.pages.dev --project-ref YOUR_PROJECT_REF
npx supabase functions deploy delete-account --project-ref YOUR_PROJECT_REF --use-api
```

Supabase автоматично надає функції її server-side project credentials. Не створюйте `VITE_SERVICE_ROLE_KEY` і не додавайте service role у frontend.

Після успішного deploy:

1. Додайте на хостингу `VITE_DELETE_ACCOUNT_ENABLED=true`.
2. Зробіть новий web build/deploy.
3. Увійдіть тестовим користувачем, підтвердьте видалення й перевірте, що:
   - current user зник з **Authentication → Users**;
   - його profile видалено каскадно;
   - його analytics events стали анонімними (`user_id = null`);
   - Wishly повернувся на `/login`.

Функція приймає поточний Supabase JWT, перевіряє його на сервері й видаляє тільки цього користувача. JWT не передається Wishly Agent і не логуються.

## 9. Production variables

Для production build задайте:

```text
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_ME
VITE_SITE_URL=https://wishly-app.pages.dev
VITE_ADMIN_EMAIL=
VITE_PRODUCT_OPERATOR=REAL_OPERATOR_NAME
VITE_LEGAL_CONTACT_EMAIL=REAL_CONTACT_EMAIL
VITE_DELETE_ACCOUNT_ENABLED=true
VITE_AGENT_URL=http://127.0.0.1:43120
```

`VITE_*` значення потрапляють у браузерний bundle. Тому там дозволені publishable key та публічні налаштування, але заборонені Google Client Secret, Supabase secret/service role key і будь-які приватні токени.

Поточний Cloudflare Pages workflow використовує Direct Upload уже зібраної `dist`. Створіть незакомічений кореневий `.env.production` з production-значеннями або задайте їх у CI перед `npm run deploy:web`; одні лише Dashboard variables не змінять уже готовий Vite bundle. Перед deployment скрипт окремо перевіряє, що production URL не є localhost і ключ не є privileged.

Для preview deployment задайте його реальний origin у `VITE_SITE_URL` та додайте точний `<preview-origin>/auth/callback` у Supabase Redirect URLs і origin у Google client. Не використовуйте production `VITE_SITE_URL` для preview, інакше OAuth поверне на production.

Повний production checklist є в [PRODUCTION.md](./PRODUCTION.md).

## 10. Database types і RLS tests

Після зміни schema згенеруйте TypeScript types і порівняйте їх з `apps/web/src/lib/database.types.ts`:

```bash
npx supabase gen types typescript --linked --schema public
```

Для локальних SQL/RLS tests потрібен запущений Docker:

```bash
npx supabase start
npx supabase db reset
npx supabase test db
npx supabase stop
```

Тести лежать у `supabase/tests/database/rls.test.sql`. Вони перевіряють ізоляцію профілів, заборону зміни plan/status, ownership analytics, admin membership і доступ до aggregates.

## 11. Що Wishly навмисно не робить

- не має власних паролів;
- не зберігає Google access/refresh tokens;
- не передає Supabase JWT або Google tokens локальному Agent;
- не завантажує відео, thumbnails, вибрані зображення, filenames або локальні paths у Supabase;
- не вважає Google Login маркетинговою згодою;
- не використовує Google Analytics, Meta Pixel, fingerprinting або сторонні trackers.
