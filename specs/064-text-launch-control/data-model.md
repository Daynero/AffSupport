# 064 · Модель даних

Назви орієнтовні, остаточні фіксує міграція. Усі нові таблиці починаються з `revoke all`, мають RLS, вузькі grants, повністю кваліфіковані імена й порожній `search_path` у `security definer`. Нові таблиці з іменем `team_*`, FK на `team_launches` чи jsonb-полями потрапляють в інвентар cleanup fence (тригер `task_cleanup_reference_fence`).

## Помічник

| Таблиця | Ключі | Вміст та інваріанти |
| --- | --- | --- |
| `public.assistant_conversations` | `id`, `team_id`, `user_id` | `created_at`, `last_active_at`, `expires_at = last_active_at + 7 днів`. Одна активна розмова на (простір, користувач). RLS: читає лише `user_id = auth.uid()` з чинним членством |
| `public.assistant_messages` | `id`, `conversation_id`, `seq` | `role` (`user` / `assistant`), `text` (≤ 4000), `cards jsonb` (лише серверні картки; кожна має `cardId` і впорядковані `{id, version}` рядків — основу для порядкових посилань), `price`, `created_at`. Видаляються разом із розмовою після `expires_at` (cron) |
| `private.assistant_commands` | `id`, `conversation_id`, `client_key` (унікальний з `user_id`) | `request_hash`, `status` (`accepted` / `parsing` / `waiting_answer` / `executing` / `done` / `partial` / `rejected` / `unknown` / `undone`), `model`, `usage_event_id`, `plan jsonb` (перевірений план без URL-значень), `reason_code` |
| `private.assistant_command_effects` | `command_id`, `step`, `row_key` | `kind` (`draft_created` / `draft_updated` / `defaults_saved`), `launch_id` або `offer_defaults_id`, `version_before`, `version_after`, `fields jsonb` (`[{path, before, after}]` для правок і дефолтів), `undone_at`. Джерело для «Скасувати» |
| `private.assistant_questions` | `id`, `command_id` | `about`, `options jsonb`, `state` (`open` / `answered` / `stale`), `answered_option` |
| `private.assistant_profile_proposals` | `id`, `command_id` | `offer_id`, `fields jsonb [{path, before, after}]`, `expected_version`, `state` (`pending` / `confirmed` / `stale`). Профіль змінюється лише через `profile.confirm`. Залежні кроки чекають `confirmed` |
| `private.assistant_url_slots` | `command_id`, `slot` | `value` — значення URL для підстановки. Читає лише service role, TTL як у розмови. В аналітику не йде |
| `private.assistant_reviews` | `id`, `user_id`, `team_id` | `selector`, `rows jsonb [{id, version}]`, `launch_date`, `timezone`, `created_at`, `launched_batch_id`. Чинний, поки збігаються версії. Таймера немає |
| `public.team_launches` (наявна) | — | Новий nullable `created_via` (`form` / `assistant`) і `assistant_command_id` для мітки «з помічника» |

Профіль офера: наявний `team_launch_offer_defaults` отримує RPC часткового оновлення `save_launch_offer_defaults_masked(team, offer, mask text[], values jsonb, expected_version, request_key)`. Поля поза маскою переносяться з чинної версії. Якщо поле з маски змінилося після `expected_version`, повертається `EDIT_CONFLICT`.

## Чарунки

| Таблиця | Ключі | Вміст та інваріанти |
| --- | --- | --- |
| `private.ai_settings` | singleton | `credit_usd` (0.001), `base_daily_grant` (100), `assistant_enabled`, `translation_enabled`, `translation_billing` (`allowance_063` / `credits`), `price_versions jsonb` |
| `private.ai_credit_grants` | `user_id` | `daily_grant`, `updated_by`, `updated_at`. Немає рядка → базовий грант |
| `private.ai_credit_ledger` | `id`; унікальний (`user_id`, `op_key`, `kind`) | `kyiv_day`, `feature`, `kind` (`debit` / `refund`), `amount` (ціле > 0), `price_version`, `created_at`. Refund лише для наявного debit того самого ключа, у ту саму `kyiv_day` |
| `private.ai_usage_events` (наявна 063) | `id` | Додати `op_key`, `feature`, `usd numeric`, `usd_source` (`priced_tokens` / `billing`), `usage_known`. Одна спроба = один рядок |
| `private.ai_budget_months` | `month` | `limit_usd`. Ліміт не можна зменшити нижче Σ USD місяця |
| `private.ai_month_holds` | `op_key` | `month`, `usd_upper`, `usd_actual`, `state` (`held` / `settled`). Вільний бюджет = ліміт − Σ фактичних − Σ `held`. Пишеться під спільним блокуванням місяця |
| `private.ai_admin_events` | `id` | `actor`, `kind`, `before jsonb`, `after jsonb`, `at` |
| `private.ai_space_pilot` | `team_id` | Простори, де помічник увімкнено |

Читання: власний баланс і останні 10 списань — RPC `ai_credits_status()` (лише свій `auth.uid()`). Адмінські агрегати — RPC з `is_admin()`. Особа платника спільного перекладу іншим користувачам не видна.

## Життєвий цикл команди

```
accepted → parsing → (rejected | waiting_answer | executing)
waiting_answer → executing        (відповідь кнопкою, без Claude)
executing → done | partial | unknown
unknown → done | partial          (звірення за ключами кроків)
done | partial → undone           (повністю або частково, ефекти з undone_at)
```

- Кожен крок пише ефект із ключем `command_id:step:row_key` до доменного виклику й передає той самий ключ у `save_launch_draft`. Після втрати відповіді звірення читає домен за ключем і лише тоді продовжує.
- Невизначений крок блокує залежні кроки.
- Закриття вкладки не скасовує прийняту команду. Стан читається з `assistant_commands`.

## Скасування

Для кожного ефекту з `undone_at is null`:
- `draft_created`: видалити, якщо `version = version_after`, генерація не запускалась і рядок не в пакеті. Інакше лишити з причиною `CHANGED_AFTER` / `LAUNCHED`;
- `draft_updated`: для кожного поля з `fields` повернути `before`, якщо поточне значення дорівнює `after`. Поле, змінене після команди, лишається з причиною `FIELD_CHANGED`. Інші поля рядка не перевіряються, тож ручна правка нотатки не блокує відкат бюджету. Запис іде з очікуваною поточною версією рядка, а при конфлікті — перечитати й перевірити поля знову;
- `defaults_saved`: так само по полях маски.

Усе в одній транзакції на команду, з ключем `undo:<command_id>`.
