# Contract: claim v2, інтерактивна доставка, перехід

## Інтерактивна доставка (`apps/web/src/team/restitch/screens.ts`)

```
known = teamApi.getRestitchDefaults(teamId)            // + sourceMode
if known.sourceMode === 'legacy' → старий шлях (ensureRestitchImages)
capability = agentCanRestitch() && restitchSourcesSupported(health.toolContracts)
  'too-old' → teamRestitchAgentTooOld (нова копія тексту: «оновіть застосунок, щоб
  брати картинки з простору»)
draw = teamApi.drawRestitchScreens(teamId)              // RESTITCH_POOL_EMPTY → стан 'pool-empty'
for screen in draw.screens:
  grant = teamApi.requestDownload(teamId, screen.materialId, 'agent')
    PERMISSION_DENIED → RESTITCH_SOURCE_FORBIDDEN
screens = draw.screens.map(+transfer)
downloadTeamFileWithAgent({ …, process: { tool:'restitch', defaults: known, prepared, screens } })
```

Той самий блок використовують `useRestitchDelivery`, `CreateProductCatalogDialog`
(прибрати `toolContractVersion: 1`, брати з shared) і `useRestitchPreparer`.

## Claim v2 (`drive-ops/updater/claim`)

Запит: `{ teamId, restitchContractVersion?: number }` (shared
`RESTITCH_CONTRACT_VERSION = 2`; відсутнє поле = 1).

Сервер:

1. Налаштування **до** claim: `service_get_effective_restitch_defaults(team, owner_id)`
   (**власник**, не claimer; R6).
2. Якщо `sourceMode='drive'` і версія запиту < 2 → відповісти
   `RESTITCH_CLIENT_OUTDATED`, **не викликаючи** `service_claim_restitch_job`
   (RPC звільнення lease без провалу не існує, а провал витрачає `attempts`).
   Вкладка показує прохання оновитись і припиняє claim до перезавантаження.
3. `service_claim_restitch_job` як і зараз.
4. `service_draw_restitch_screens(team, owner_id)`; `RESTITCH_POOL_EMPTY` →
   `service_defer_restitch_job(job, lease, 'RESTITCH_POOL_EMPTY', interval)`: новий
   RPC, що ставить `next_attempt_at = now() + інтервал апдейтера`, записує причину
   в `last_error_code`, **не** інкрементує `attempts`; чип апдейтера показує причину;
   наступний claim після інтервалу переобчислює.
5. На кожен screen видати `download_range`-грант агента через
   `issue_team_transfer_grant` від імені власника (той самий шлях, що для
   `sourceGrant`). Якщо грант падає (`PERMISSION_DENIED`, `TOO_LARGE`), одна повторна
   спроба `service_draw_restitch_screens` з `p_exclude` = цей матеріал; друга невдача →
   `fail(job, 'RESTITCH_SOURCE_FORBIDDEN')`.
6. У відповіді `job.options.screens` поряд із `defaults` і `prepared`.

Інтерактив робить те саме для кроку 5: `prepareRestitchScreens` при збої гранта
викликає `drawRestitchScreens(teamId, { exclude: [materialId] })` один раз.

`useRestitchPreparer` передає `options.screens` у `startProcess` без змін форми.

## Панель (`RestitchDefaultsSection` → `RestitchSourcePools`)

- Стан форми з `list_restitch_sources`; агент не потрібен для перегляду й
  збереження. Кнопка «Зберегти» активна без агента.
- Два пули, кожен: список джерел (ім'я, вид, `availability`, лічильник,
  відсіяні), «Додати файли» (`TaskAttachmentPicker`, `accept: category==='image'`),
  «Додати папку» (`FolderPicker`), вилучення.
- Підсумок стану пулу: `ready`/`partial`/`empty`/`over_limit` з текстом.
- Учасник на успадкованих: читання `list(…,'owner')`, без кнопок, позначка
  «налаштування власника», чекбокс «використовувати мої».
- Legacy: банер «потребує перевибору» з `legacyImageCount`, дії «Перевибрати»
  (відкриває пікери) і, з релізу C, «Перенести старі картинки в простір».
- Fit/тривалості/перемикачі/операція як і раніше, але зі стану форми, не з
  локального компресора.

## Перехід (реліз C)

- «Перенести старі картинки»: браузер читає об'єкти з бакета (SELECT-політика
  ще є), вантажить через `drive-ops /uploads` relay у `Soty/Re-stitch images/<slot>`
  (папку створює `ensure-workspace-folder`), викликає `set_restitch_sources`
  з `{ driveFileId, kind:'folder' }`; після індексації джерело стає `available`.
- `delete-account`: видаляє об'єкти `*/<userId>/*` з `team-restitch-images`
  і рядки особистих пулів (cascade).
- Видалення 98 об'єктів: окрема міграція з явним переліком після інвентаря
  (`scripts/` read-only звіт), поза цією фічею як код, але в її tasks як гейт.

## Межа старих клієнтів, підсумок

| Клієнт                       | Пул простору `legacy`                    | Пул простору `drive`                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Старий агент + стара вкладка | працює старим шляхом                     | claim: `RESTITCH_CLIENT_OUTDATED` до взяття задачі; інтерактив: вкладка стара, не знає `draw` → старий шлях бачить порожні uuid[] → «не налаштовано» (FR-026, прийнятно: та сама вкладка не може оновити агент) |
| Старий агент + нова вкладка  | працює старим шляхом                     | `teamRestitchAgentTooOld`                                                                                                                                                                                       |
| Новий агент + стара вкладка  | працює старим шляхом                     | claim: `RESTITCH_CLIENT_OUTDATED`                                                                                                                                                                               |
| Новий агент + нова вкладка   | банер «потребує перевибору», старий шлях | новий шлях                                                                                                                                                                                                      |
