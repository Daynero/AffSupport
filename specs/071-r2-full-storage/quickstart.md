# Quickstart: перевірка 071 на beta

Нічого з цього не виконується на продакшні без підтвердження власника.

## Підготовка середовища

1. Cloudflare: бакет `soty-media-beta` з власним доменом медіа beta (без `r2.dev`, без лістингу) і бакет `soty-private-beta` без домену; CORS з origins beta-web на обох; bucket lock 7 днів; окремий API-токен на кожен бакет.
2. Секрети edge (beta): `R2_STORAGE_ACCOUNT_ID`, `R2_MEDIA_BUCKET`, `R2_MEDIA_ORIGIN`, `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PRIVATE_ACCESS_KEY_ID`, `R2_PRIVATE_SECRET_ACCESS_KEY`, `R2_STORAGE_TARGET_CONFIRMATION=beta:<account>:soty-media-beta:soty-private-beta:<media origin>`, `STORAGE_WORKER_SECRET`.
3. `update private.storage_r2_config set enabled=true, policy_confirmed_at=now()` тільки на beta.

## Сценарії

1. **US1.** Створити тестовий простір, перевести на `r2` (адмінка). Завантажити відео 500 МБ, обірвати мережу на 50%, відновити: завантаження продовжується. Прев'ю з перемоткою. У DevTools немає запитів на `googleapis.com` і на `drive-transfer`.
2. **Квота.** Поставити override 1 ГБ, завантажити 1.2 ГБ: відмова до передачі байтів, `STORAGE_QUOTA_EXCEEDED`.
3. **US5.** Видалити матеріал, очистити кошик. `select * from private.storage_tombstones` показує `not_before = +7 днів`. Відновити через адмінку. Спробувати `DeleteObject` ключем сервера на свіжому об'єкті: lock відмовляє.
4. **US2.** Агент нової версії на macOS і Windows: стиснення, рестітч, рендер лендингу. Агент старої версії: `AGENT_UPDATE_REQUIRED`.
5. **US3.** Завантажити відео, скопіювати його постійне посилання й відкрити анонімно у вікні інкогніто. Каталог на 100 товарів опубліковано за ≤ 2 с; URL фіда, golden-порівняння колонок, підключити URL у тестовому каталозі Meta, оновлення тексту з'являється у фіді за 5 хвилин.
6. **US4.** Простір на Drive з даними: запланувати, побачити банер, запустити перехід, повторити запуск (без змін), перевірити `archived_drive` і посилання «файл на Google Drive», а в Drive нічого не видалено.
7. **Аналітика.** `npm run analytics -- storage --period 7d --json` показує обсяги й події.
