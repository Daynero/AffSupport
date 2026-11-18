# Research — 059 Ранги креативів

Рішення про сигнал і модель даних погоджені власником 2026-11-18 (`scratchpad/creative-ranks/PLAN.md`).
Тут — як саме їх вбудувати в наявний код.

## R1. Де ловити «перший успішний generate»

**Decision**: deferred constraint trigger `AFTER UPDATE OF state ON team_launch_generations`
(`DEFERRABLE INITIALLY DEFERRED`), умова `new.state = 'succeeded' and old.state <> 'succeeded'`.
Креатив — `team_launch_revisions.config->>'materialId'` ревізії генерації. Подія ledger:
`('launch', launch_id)`, `on conflict do nothing` — отже рахується лише перший успіх Launch.

**Rationale**: у `succeeded` переводять щонайменше дві функції публікації
(`service_publish_launch_generation`, `service_publish_launch_batch_other_generation`), і нова може
з'явитися. Тригер на таблиці покриває всі шляхи, включно з майбутніми, без змін у них. Deferred —
бо `team_launch_revision_catalogs` і стан генерації пишуться в одній транзакції різними кроками;
до коміту видно все, що коміт фіксує. Rollback транзакції прибирає і подію.

**Alternatives**: виклик у кожній publish-функції — легко пропустити шлях; клієнтський виклик —
заборонено FR-005; лічильник на `team_launches` — не дає журналу для діагностики.

## R2. Де ловити «каталог напряму»

**Decision**: `AFTER INSERT ON team_product_catalogs` (deferred), подія `('catalog', catalog material_id)`
для `video_material_id`. Оновлення рядка (заміна відео 054, upsert при перегенерації) нової події
не створює — ключ той самий.

**Rationale**: усі шляхи створення каталогу (діалог, оновлювач, Launch) закінчуються вставкою в цю
таблицю. `video_material_id` — оригінальне відео; перезшиті копії живуть у
`team_catalog_restitch_copies` і не стають креативами (edge case спеки).

## R3. Дедуплікація «каталог із Launch»

**Decision**: симетричне поглинання, незалежне від порядку подій.

- Подія `launch`: якщо ревізія має `team_launch_revision_catalogs.catalog_id = C`, і подія
  `('catalog', C)` існує й ще не поглинута — позначити її `absorbed_by_launch_id`, а сама подія
  `launch` проєкцію **не** збільшує (лише оновлює `last_launched_at`).
- Подія `catalog`: якщо `C` уже згадано в ревізії Launch, чия подія `launch` зарахована, — вставити
  подію одразу поглинутою, без +1.
- Launch, що перевикористав чужий уже поглинутий каталог (names-only ревізія), рахується як звичайний +1.

**Rationale**: у потоці каталог реєструється раніше за успіх (`catalog_registering` → `succeeded`),
але бекфіл і майбутні шляхи можуть іти в іншому порядку. Поглинання дає рівно +1 на пару.

**Alternatives**: розпізнавати Launch-каталог за `catalog_generation_intents.request_key like 'launch:%'`
у момент вставки — результат intent може записуватись після вставки; крихко.

## R4. Проєкція і пониження

**Decision**: `team_creative_ranks` (PK team_id+material_id) з `launch_count`, `rank_credit`,
`last_launched_at`, `demoted_*`, `version`. Оновлюється тими ж тригерами (`insert … on conflict do update`).
Пониження — RPC `demote_creative_rank(team, material, reason, target_credit, expected_version, request_key)`.
Щоб пороги жили в одній константі (FR-006), сервер їх не знає: клієнт обчислює `target_credit`
(поріг цільової ліги) з єдиної веб-константи, а сервер перевіряє роль owner, `expected_version`
(CAS → `RANK_CONFLICT`) і `0 <= target_credit < rank_credit`. Причина — закритий enum. Ідемпотентність — `request_key`
унікальний на (team, material): повтор того самого ключа повертає збережений результат.

**Rationale**: зміна порогів — одна правка у `apps/web/src/team/ranks/creativeRanks.ts`, без міграції; сервер захищає
інваріанти, які від порогів не залежать (лише понижує, лише owner, рівно раз).

## R5. Бекфіл

**Decision**: у тій самій міграції після створення тригерів:

1. подія `launch` на кожен Launch з хоча б однією `succeeded` генерацією; `occurred_at` = `updated_at`
   найпершої такої генерації; креатив — з її ревізії;
2. подія `catalog` на кожен рядок `team_product_catalogs` (`occurred_at` = `created_at`);
3. поглинання за правилом R3;
4. проєкція = агрегат журналу (`count` непоглинутих, `max(occurred_at)`).

Усе через `on conflict do nothing` — повторний запуск не задвоює (US4-2). Креатив, якого вже нема в
`team_materials`, пропускається.

## R6. Читання для плиток

**Decision**: RPC `list_creative_ranks(team, material_ids uuid[])` (≤ 500 id), security definer з
перевіркою членства; повертає лише рядки, що існують. Відсутність рядка = «Віск, без запусків».
Клієнт читає пачкою для видимої сторінки провідника (FR-018). Деталі UI-шару — R7 після розвідки.

## R7. Плитки і детальний перегляд

**Decision**:

- Ранги читаються пачкою на сторінку провідника за зразком `getMaterialRestitchPrep`
  (`ExplorerShell.tsx:645–679`): один виклик `teamApi.listCreativeRanks(teamId, videoIds)` на
  `[teamId, page.rows, ranksRevision]`, результат — `Map`, що йде в `ContentGrid`/`ContentList`.
- Плитка: емблема 36 px (асет 64) у правому нижньому куті прев'ю, у вже наявному
  `.team-explorer-tile-badge-layer` (лівий низ — companions, верх — чекбокс і меню; нічого не перекриває).
  Текст `N× · давність` — у рядку фактів підпису (`.team-explorer-tile-facts`), де він завжди
  контрастний і не залежить від стану емблеми (FR-013).
- Список: емблема 20 px поруч із `TagDot` у клітинці назви, текст у `title`/доступній назві.
- Детальний перегляд: новий слот `rank` у `MaterialDetail` після фактів; хост `PreviewPane` передає
  `<MaterialRank teamId material revision/>`, який сам читає ранг одного матеріалу тим самим RPC.
- Пониження: `DropdownMenu` з двома пунктами-причинами під кнопкою «Понизити ранг» — два кліки,
  без окремого підтвердження (дія відворотна новими запусками). Лише `activeTeam.role === 'owner'`,
  як `canTag` (`ExplorerShell.tsx:430`).
- Емблема — `<img src="/creative-ranks/{league}_{freshness}-{64|128}.webp" width height alt="…">`;
  `img-src 'self'` уже дозволяє. Перший WebP у `public/` — свідомий вибір (30 файлів ≈ 100 КБ).

**Alternatives**: додати ранг у `list_team_folder_page` — змінює гарячий RPC сторінки й тягне
перезбирання всієї сторінки при кожному запуску; окремий батч дешевший і ізольований.

## R8. Realtime

**Decision**: тригер проєкції вставляє `team_catalog_events(team_id, material_id, 'creative_rank')`
(новий `event_kind`: переозначити `team_catalog_events_kind_check`). `catalogEventDomains.ts` віддає
для нього новий домен `ranks`; `TeamContext` веде окремий `ranksRevision`, тож зміна рангу перечитує
лише пачку рангів, а не сторінку провідника. Дебаунс 1 с уже є в `useTeamRealtime` — пачка зі 100
запусків дає одне перечитування.

## R9. Права

**Decision**: читання — `private.can(p_team,'view')`; пониження — `private.team_role(p_team, auth.uid()) = 'owner'`
(повертає null для неактивного простору/профілю), інакше `PERMISSION_DENIED` / `42501`.
Конфлікт версії — `RANK_CONFLICT` / `PT409`; «не нижче» — `RANK_NOT_LOWER` / `PT409`.

## R10. Аналітика і діагностика

**Decision**:

- Веб-події в `apps/web/src/analytics/events.ts` (не в `packages/shared`, щоб лишитись на швидкому шляху веб + бекенд): `creative_rank_demote_started`
  (reason, from_league, to_league, flow id) і `creative_rank_demote_finished` (+ outcome
  `applied|rejected_role|rejected_not_lower|conflict|failed`), `creative_rank_read_failed`
  (tile_count). Seam `team/ranks/analytics.ts` за зразком `team/launches/analytics.ts`.
- Нових ключів немає: події несуть наявні `flow_id`, `feature_identifier`, `action_identifier`,
  `source_kind`, `input_method`, `outcome`, `error_code`, `item_count` (значення-токени без `_`).
  Тож `analytics_properties_are_safe_v2` не переозначається — і не конфліктує з 058, яка
  переозначає його у `20261218100000_navigation_analytics_guard.sql`.
- `coverage-registry.ts`: capability `creative_rank_demote` (start → terminal) і
  `creative_rank_credit` (фонова, доказ — журнал).
- CLI: `npm run analytics -- creative-rank --team <id> --material <id>` читає журнал і проєкцію через
  RO-роль (`grant select` для `wishly_analytics_ro`) і пояснює кожну подію: зараховано / поглинуто /
  не перший успіх; для Launch без події — стан його генерацій.
