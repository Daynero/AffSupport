# Data Model: 058

Сутностей у БД немає; це клієнтські типи та одна аналітична подія.

## ScreenKind (закритий перелік)

`public_home`, `public_legal`, `auth`, `tools_home`, `tool`, `account`, `admin`,
`team_lobby`, `team_gate`, `team_explorer`, `team_tasks`, `team_launches`,
`team_accounts`, `team_members`, `team_settings`, `team_trash`, `other`.

`screenOf(route: string): ScreenKind` — чиста функція з `motion-registry.ts`.

## MotionKind

`page` (зміна розділу застосунку) · `section` (розділ простору) · `none` (зміна в межах екрана).
Оверлеї мають власну пару появи/закриття й не проходять через роутер.

## RegistryEntry

| Поле | Тип | Правило |
|------|-----|---------|
| `screen` | `ScreenKind` | унікальний |
| `motion` | `MotionKind` | вид входу на екран |
| `skeleton` | `RouteSkeletonVariant \| null` | варіант заготовки, якщо екран ліниво завантажується |
| `smoke` | `boolean` | чи покритий `motion-smoke.mjs` |

## NavigationAttempt (у пам'яті → одна подія)

Стан: `preparing → committing → animating → settled` або фінал раніше.

| Поле | Значення |
|------|----------|
| `flow_id` | UUID спроби |
| `nav_from_screen`, `nav_to_screen` | `ScreenKind` |
| `nav_motion` | `page \| section` |
| `nav_mode` | `animated \| instant_reduced \| instant_lite \| instant_hidden \| fallback_enter \| skipped` |
| `nav_skip_reason` | `none \| theme_active \| superseded_in_flight \| unsupported \| redirect` |
| `nav_final` | `settled \| superseded \| cancelled \| chunk_failed` |
| `nav_history` | `push \| replace \| pop` |
| `prepare_ms` | час до коміту (очікування чанка) |
| `duration_ms` | клік → вміст готовий |
| `skeleton_ms` | скільки була видна заготовка (0 — не було) |
| `layout_shift_milli` | сума зсуву за 2 с після готовності × 1000 |
| `long_frame_count` | кадри > 50 мс протягом переходу |
| `browser_family` | наявний ключ |

Переходи станів: `superseded` — нова навігація до `settled`; `cancelled` —
`BEFORE_NAVIGATION_EVENT` скасовано (незбережені зміни); `chunk_failed` —
завантаження розділу кинуло помилку; редирект впродовж спроби фіксується як
`nav_skip_reason=redirect` у тій самій спробі.

Вибірка: подія завжди надсилається при `skeleton_ms>0`, `nav_mode∈{instant_lite,skipped}`,
`nav_final≠settled`, `layout_shift_milli>50`, `long_frame_count>0`; інакше 10 %.
Ліміт — 60 подій на аналітичну сесію.
