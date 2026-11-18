# UI contract — 059

## Константи і парсер (`apps/web/src/team/ranks/creativeRanks.ts`)

Не в `packages/shared`: зміна shared вимагає повного релізного раннера, а фіча — лише веб + бекенд.

- `CREATIVE_RANK_LEAGUES` — `[{ id: 'wax', min: 0 }, { id: 'bronze', min: 1 }, { id: 'silver', min: 5 }, { id: 'gold', min: 15 }, { id: 'diamond', min: 40 }]`.
- `CREATIVE_RANK_FRESHNESS_DAYS` — `{ fresh: 14, dusty: 60 }` (усе, що старше 60, — `cobweb`).
- `leagueOf(credit)`, `freshnessOf(lastLaunchedAt, now)` (майбутня дата → `fresh`),
  `demotionTarget(credit, reason)` → `{ league, credit } | null` (null = нижче нікуди).
- `parseCreativeRankList(unknown)` → `{ ok, value } | { ok: false, error }`.

## Компоненти (`apps/web/src/team/ranks/`)

- `RankEmblem({ league, freshness, size: 'tile' | 'list' | 'detail' })` — `<img>` з
  `/creative-ranks/{n}_{league}_{freshness}-{128|256}.webp`, фіксовані `width/height` з токенів розміру,
  `alt` = «Ліга: Золото, свіжий». Розмір через клас, не інлайн-стиль.
- `RankFacts({ rank })` — `74× · 2 дн тому` / «ще не запускали»; відносна дата через наявний форматер `format.ts`.
- `MaterialRank({ teamId, materialId, revision })` — слот детального перегляду: емблема 128, назва ліги,
  свіжість, кількість, дата, для owner — `DropdownMenu` «Понизити ранг» з двома причинами.
- `useCreativeRanks(teamId, videoIds, ranksRevision)` → `Map<materialId, CreativeRank>`; помилка читання —
  нейтральний стан (без емблеми), а не Віск, + подія `creative_rank_read_failed`.

## Тексти (uk / en, `locales`)

`rank.league.wax` «Віск» … `rank.league.diamond` «Алмаз», `rank.fresh` «свіжий», `rank.dusty` «запилений»,
`rank.cobweb` «у павутинні», `rank.launches` «{count}×», `rank.never` «ще не запускали»,
`rank.demote` «Понизити ранг», `rank.reason.disappointed` «Розчарувався», `rank.reason.never_launched`
«Так і не запустив», `rank.demote.conflict` «Ранг щойно змінився — показуємо актуальний».

## Стилі

Лише токени з `styles/tokens.css`; нові розміри емблеми — токени `--rank-emblem-tile|list|detail`
у token-шарі.

Геометрія (за макетом власника 2026-11-18): усі 15 файлів — один квадрат, сота в центрі й однакова
в усіх лігах (≈ 52 % сторони); вищу лігу роблять більшою лише крила, корона, лаври. Сота: плитка ≈ 34 px,
список ≈ 17 px, детальний перегляд ≈ 65 px.

- Плитка — лівий верхній кут картинки, сота по центру там, де чекбокс; під hover/focus/вибором емблема
  ховається й поступається чекбоксу. Без hover (тач) — правий нижній кут.
- Список — окрема колонка одразу після назв: колонка назв завширшки з найдовшу назву, тож соти стоять
  однією вертикаллю; емблема в кожного відео, включно з Воском; точні факти — у підказці.
