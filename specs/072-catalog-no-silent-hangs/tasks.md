# Tasks: Каталог ніколи не висить мовчки (072)

Позначки: `[x]` зроблено, `[ ]` ні. Пакет у дужках. П1/П2 — сервер, решта — інші агенти (див. `plan.md`).

## П1 — закриття раундів і черга

- [x] T101 Класифікація кодів `private.catalog_round_failure_kind` (П1).
- [x] T102 `private.close_catalog_variant_round` — одне завершення раунду з кодом (П1).
- [x] T103 `service_fail_catalog_updater_variant_admission`: final одразу, passing пауза+межа 30 хв, `NEEDS_REAUTH` позначає Drive, `RESTITCH_*` на старих налаштуваннях — одна спроба з ефективними (П1).
- [x] T104 `service_fail_catalog_updater_variant_target`: межа 2 год для готового набору (#8) (П1).
- [x] T105 Колонки `retry_at`, `first_error_at`; ширші перевірки кодів у запиті й знімку (П1).
- [x] T106 Нотатка: годинник збою скидає лише `set_admitted` без коду (П1).
- [x] T107 Списки без голодування: пропуск паузи, порядок за належним часом (#2) (П1).
- [x] T108 Реєстр: код запиту → `waitReason`/`waitCode`; `agent_block_code` → `backgroundStalled`+`waitCode` (П1, П4).
- [x] T109 cron `settle_catalog_round_limits`: каталог у кошику/поза менеджером (#7), непридатний Drive у раунді з відео (#5) (П1).
- [x] T110 drive-ops: catch прийняття, посилань і `prepareScheduledCatalogVideoSets` передають код; запасний шлях на стару нотатку (П1).
- [x] T111 pgTAP `catalog-round-no-silent-hang.test.sql` (46), vitest `catalog-updater-variants.test.ts` (+4) (П1).

## П2 — передперевірки й межі чекання

- [x] T201 `private.catalog_run_preflight` у run/retry/command: SPACE_BLOCKED → Drive → AGENT_REQUIRED (#3, #13 сервер, #14) (П2).
- [x] T202 `note_catalog_variant_round_wait`: final одразу (PERMISSION_DENIED→SPACE_BLOCKED у паузі), agent межа 2 год з паузою 1→15 хв, passing 30 хв (#3) (П2).
- [x] T203 cron: набір ніхто не взяв 6 год → AGENT_REQUIRED/AGENT_STALLED; комп'ютер сказав «зупинився» ≥1 год → його код (#4) (П2).
- [x] T204 pgTAP `catalog-round-wait-limits.test.sql` (37) (П2).
- [x] T205 `AGENT_STALLED` у `TEAM_ERROR_CODES` + `COPY` в `errors.ts` + `team_error_codes` — одним комітом разом із П6 (див. plan.md «Знахідки») (П2/П6). Зроблено П6: `TEAM_CATALOG_HANG_ERROR_CODES` + міграція 20261224260000.
- [ ] T206 Перевірка версії виконавця при прийнятті (#12, `AGENT_UPDATE_REQUIRED` до claim) — не зроблено (П2, наступний крок).

## П3 — публікація

- [ ] T301 «Опублікувати ще раз», тригер повернення `target_unavailable`, передперевірка створення (П3, міграція 20261224210000).

## П4 — агент

- [ ] T401 `localState` у probe → `agent_block_code`; preupload; storageQuotaExceeded; macOS-сховище (П4, міграція 20261224190000).

## П5 — рядок менеджера

- [ ] T501 Помилка раунду в рядку й у «Потрібна увага»; кнопка за кодом (див. plan.md «Коди й дії»); незнайомий `waitReason` — загальний текст; читати `waitCode` (П5).

## П6 — створення каталогу й тексти

- [ ] T601 Передперевірки створення, тексти кодів без перекладу, `AGENT_ID_CONFLICT` (П6).

## Перевірка

- [x] T901 pgTAP П1+П2 на беті в транзакції (rollback) — усе зелене; сусідні `catalog-round-restitch-settings`, `launch-multi-creative` зелені.
- [x] T902 `npm run test:db`: ланцюг міграцій зелений, 96/97 файлів pgTAP; єдиний збій — `team-workspace` test 16 (`team_catalog_creation_preflight` П3 не в білому списку authenticated). PGlite-набори каталогу зелені, крім `catalog-updater-detached-connection-sql` (очікує NEEDS_REAUTH, а 20261224230000 П5 тепер дає CONNECTION_DETACHED).
- [x] T903 Накатати 200000/220000 на бету, штучно відтворити раунд RESTITCH_INVALID/PERMISSION_DENIED, переконатись, що закривається; повернути бету.
