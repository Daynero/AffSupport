# Wishly production checklist

## Перед першим публічним запуском

- [ ] SQL migrations застосовані в порядку з `supabase/migrations/`.
- [ ] RLS увімкнений для `profiles`, `admin_users` і `analytics_events`.
- [ ] Supabase Site URL — `https://wishly-app.pages.dev`.
- [ ] Supabase redirect allowlist містить `https://wishly-app.pages.dev/auth/callback`.
- [ ] Google Authorized JavaScript origins містить `https://wishly-app.pages.dev`.
- [ ] Google Authorized redirect URI точно збігається із Supabase provider callback `https://PROJECT_REF.supabase.co/auth/v1/callback`.
- [ ] Google Data Access містить тільки `openid`, email і basic profile.
- [ ] `VITE_PRODUCT_OPERATOR` і `VITE_LEGAL_CONTACT_EMAIL` заповнені реальними значеннями.
- [ ] Власник перевірив Privacy Policy і Terms of Use; це базові тексти, а не юридична консультація.
- [ ] Edge Function `delete-account` розгорнута до ввімкнення `VITE_DELETE_ACCOUNT_ENABLED=true`.
- [ ] Перший admin доданий UUID-командою з `SUPABASE_SETUP.md`.
- [ ] Реальні credentials відсутні в Git.

## Production build environment

Project: `wishly-app`. Production origin: `https://wishly-app.pages.dev`.

Додайте у production build environment:

| Variable                        | Production value                               |
| ------------------------------- | ---------------------------------------------- |
| `VITE_SUPABASE_URL`             | Project URL із Supabase                        |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` із Supabase               |
| `VITE_SITE_URL`                 | `https://wishly-app.pages.dev`                 |
| `VITE_ADMIN_EMAIL`              | необов’язкова development-підказка або порожнє |
| `VITE_PRODUCT_OPERATOR`         | реальне ім’я/назва оператора                   |
| `VITE_LEGAL_CONTACT_EMAIL`      | реальний contact email                         |
| `VITE_DELETE_ACCOUNT_ENABLED`   | `true` тільки після deploy Edge Function       |
| `VITE_AGENT_URL`                | `http://127.0.0.1:43120`                       |

Не додавайте на frontend-хостинг Google Client Secret, Supabase secret/service role key або JWT. Не друкуйте значення environment variables у build logs.

Cloudflare project використовує **Direct Upload**: Cloudflare отримує вже готову папку `dist`, тому Dashboard variables не можуть змінити Vite bundle після build. Для поточного workflow створіть у корені незакомічений `.env.production` з таблицею значень вище або передайте ці самі змінні в CI, де запускається build. `.env.production` уже ігнорується Git.

`git push` сам по собі не оновлює сайт. Чинна release-процедура спочатку відхиляє відсутні variables, localhost origin і privileged Supabase key, а потім перевіряє незмінний Agent artifact:

```bash
npm run deploy:web
```

Команду запускайте тільки після зелених `format:check`, `lint`, `test`, `build`, чистого commit і доступного versioned Agent release. Скрипт сам відмовиться деплоїти невідповідний release.

## SPA routing

`apps/web/public/_redirects` містить:

```text
/* /index.html 200
```

Тому прямі production-переходи на `/compressor`, `/account`, `/admin`, `/privacy`, `/terms` і `/auth/callback` повертають SPA shell, а router обробляє маршрут у браузері.

## Preview deployment

Preview повинен мати власний стабільний origin:

1. задайте preview origin у `VITE_SITE_URL`;
2. додайте точний `<preview-origin>/auth/callback` у Supabase Redirect URLs;
3. додайте `<preview-origin>` у Google Authorized JavaScript origins;
4. не вмикайте delete-account, доки origin не доданий у CORS secret функції;
5. перевірте login, callback, refresh session і прямий `/compressor`.

Якщо preview URL змінюється для кожного commit, використовуйте окремий стабільний preview alias. Не відкривайте широкі production wildcard redirects лише заради випадкових preview URL.

## Smoke test після deployment

1. У приватному вікні відкрийте `https://wishly-app.pages.dev/compressor`: має бути redirect на `/login`.
2. Перемкніть UA/EN; маршрут і layout мають залишитися стабільними.
3. Увійдіть через Google і перевірте повернення на `/compressor`.
4. Оновіть сторінку — session має відновитися без миготіння login.
5. Перевірте profile й одну безпечну event у Supabase.
6. Перевірте Agent connected flow. Supabase JWT не повинен зʼявитися в loopback requests.
7. Запустіть коротку compression, тимчасово вимкніть мережу й переконайтеся, що Agent завершує локальну роботу. Analytics може дочитатися з обмеженої черги пізніше.
8. Перевірте account update, consent on/off і logout.
9. Перевірте `/admin` звичайним користувачем і admin-користувачем.
10. Після deploy Edge Function перевірте delete-account окремим тестовим акаунтом.

## Зміна production-домену

Не розкидайте нову адресу по коду. Змініть:

1. `PRODUCTION_SITE_ORIGIN` у `packages/shared/src/release.ts`;
2. `PUBLIC_SITE_ORIGIN` у `config/production.env`;
3. `VITE_SITE_URL` на хостингу;
4. Supabase Site URL і точний redirect URL;
5. Google origin, Branding links та, за потреби, verified domain;
6. `WISHLY_SITE_URL` secret Edge Function;
7. Cloudflare custom domain.

Потім запустіть `npm run release:check`.
