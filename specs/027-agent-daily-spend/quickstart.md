# Quickstart validation

Це інструкція для майбутньої реалізації. Нові RPC/тести ще не створені; наведені очікування не є звітом про проходження.

## Передумови

Працювати з кореня репозиторію, встановленими залежностями, локальним Supabase/Docker і beta fixtures. Прочитати docs/BETA.md. Не використовувати production URL, ключі чи міграції. Beta використовує справжню локальну авторизацію; VITE_LOCAL_DEV_AUTH тут не застосовується.

```bash
npm run beta:doctor
npm run beta:up
```

Forward migrations застосувати штатним локальним beta workflow; перед beta:reset врахувати, що він стирає локальні дані, тож для smoke використовувати лише виділений тестовий baseline. Створити editor і viewer у тестовому просторі, соц X/Y, агента A з тегами, запуском і завданням; окремо недоступний їм простір.

## Контрольний набір

Вибрати завершений місяць, агента створити до його початку у fixture. За 10 число: balance 70.00, topup 200.00, spend 130.00. За 12 число: явний spend 0.00, інші поля порожні. Перенести A з X до Y з 15 числа. За 16 число: balance 20.00, topup 50.00, spend 80.00.

Очікування: spend 210.00, topup 250.00; X — 130.00/200.00, Y — 80.00/50.00. Залишки 70 і 20 видно лише на свої дати, суми «90» немає. За 11 число всі поля порожні. Історія A та зв'язки із завданням/тегами/запуском збережені.

1. Відкрити день/місяць/попередній місяць; заповнити три поля клавіатурою, перевірити помилку, Escape, dirty navigation та повернення focus.
2. У двох сесіях одночасно змінити той самий spend: друга зміна має конфлікт. Різні metrics зберігаються без втрати. Повторити той самий request UUID: одна подія/сума.
3. Спробувати move у дату з уже внесеними фінансами, в інший team, у соц із колізією ID; переконатися у відсутності часткового результату. Гонку move/write перевірити двома реальними DB connections.
4. Окремо очистити spend, balance і topup одиночними діями та відновити кожне через Undo; новіша зміна блокує Undo, повтор того самого Undo request не створює події, no-op clear не пропонує Undo. Clear topup лише 16 числа, перевірити незмінність 10 числа; Undo відновлює 50.00. Після іншого редагування Undo відмовляє й не затирає нову суму.
5. Північ перевірити контрольованим browser clock, з clean/dirty/pending editor; foreground після сну й realtime reconnect перечитують дані та не змінюють дату чернетки.
6. Viewer може читати/експортувати, але всі write RPC відмовляють. Сторонній простір недоступний; відкликання membership прибирає кеш і блокує export/retry.
7. Видалення A/X/Y з історією відхиляється, навіть якщо актуальні поля очищені. Видалення агента без фінансів працює. Draft-team shortcut з історією відмовляє. Штатне явне видалення всього тестового простору перевіряти лише в окремій disposable fixture.
8. Міграційний fixture з balance=320/topup=100: обидва в legacy, нові денні поля порожні. Старі set/clear RPC відмовляють. Імпорт confirmed topup на обрану дату проходить один раз; існуюче денне поле не перезаписується.
9. Завантажити Excel: п'ять аркушів, усі дати місяця, дві колонки A під X/Y, blank ≠ zero, leading-zero ID текстом, formula-looking назви текстом, точні totals. Відкрити в Excel без repair prompt; незалежним reader перевірити значення, типи, merges, freeze panes. Окремо лютий 28/29, місяць 31 день і single-day export.
10. Окремий fixture: повернути A з Y до X з 20 числа й внести spend=10.00 за 21 число. У matrix рівно дві колонки для A: X=140.00 та Y=80.00; agent/team spend=220.00. Підсумок topup лишається 250.00. Перевірити і UI, і всі три матричні аркуші, включно з порожнім періодом розміщення.
11. Створити агентів біля UTC-півночі в timezone America/Los_Angeles та Asia/Tokyo: starts_on дорівнює локальній даті server created_at. Інша timezone перегляду не змінює starts_on. Старий виклик без timezone дає UTC; invalid timezone не створює ні agent, ні placement.
12. Виміряти p95 20 перемикань і 20 exports на fixture 100 соц/500 агентів/31 день; записати середовище й результати проти SC-002/SC-005. Не оголошувати продуктивність підтвердженою за unit tests.

## Команди перевірки після реалізації

```bash
npm run types:supabase:local
npm run build -w @video-compressor/shared
npm run test:team
npm run test:db
npm run check:accounts-layout
npm run build:web
npm run verify
npm run verify:release
```

Команда types:supabase:local реалізована й генерує типи через `supabase gen types typescript --local --schema public` у `apps/web/src/lib/database.types.ts`. `database.compat.ts` зберігає типи застосунку та явно nullable RPC arguments, які pg-meta не визначає зі схеми. Наявна types:supabase використовує --linked, тому тут її не запускати. До verify включені нові tests/team-agent-finance*.test.ts(x), exporter і регресія tests/product-catalog-xlsx.test.ts. Двосесійний тест `team-agent-finance-concurrency-e2e.test.ts` входить у штатний release/e2e gate та дозволяє лише loopback PostgreSQL. Edge handler має пройти перевірку Edge Functions. Незалежні важкі verification/build команди виконувати послідовно.

Перед завершенням зафіксувати: machine-readable verification-result.json, результати реальної конкурентності/RLS, layout checks, контрольний workbook і measurements. Жоден із цих кроків не дозволяє production deploy; випуск — лише за docs/PRODUCTION.md.
