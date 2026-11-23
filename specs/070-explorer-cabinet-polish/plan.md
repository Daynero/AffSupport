# План 070 · Вилизаний провідник і особистий кабінет

**Гілка** `070-explorer-cabinet-polish` (чернетка на `claude/project-thread-a0wwpa`) · **База** `0e11107b` (`integration/1.6-polish` + PR 13, T001) · [Вимоги](spec.md) · [Задачі](tasks.md) · [Дослідження](research.md) · [Аналіз](analysis.md) · [Приймання](quickstart.md)

## Що постачаємо

Провідник з панеллю в один рядок, одним пошуком, сортуванням заголовками, деревом, що змінює ширину, і одним діалогом обробки. Шапка простору, яка мовчить, доки все добре. «Акаунти», налаштування, учасники, менеджер каталогів, діалоги й старі екрани інструментів — на інвентарі HeroUI, без шиму й саморобних підказок. П'ять ширин замість 34. Решта 024 закрита тут.

## Технічний контекст

TypeScript strict, React, HeroUI v3 (React Aria + Tailwind v4), токени `styles/tokens.css`. Лише `apps/web`. Без міграцій, Edge-функцій, змін агента й оболонок (FR-044). Тести: Vitest single-worker (`--pool=forks --poolOptions.forks.singleFork=true`), DOM-тести за ролями й назвами, Playwright-скрипти розкладки на зразок `scripts/check-accounts-layout.mjs`. Перевірка — `npm run verify`.

## Структура після зміни

```
apps/web/src/team/explorer/
  ExplorerShell.tsx        ≤ 800   стан, провайдери, композиція
  ExplorerToolbar.tsx              шлях, пошук, «Завантажити ▾», вигляд, «…»   (US1, US3)
  ExplorerSelection.tsx            SelectionBar інвентаря, host 'selection'    (US3)
  ExplorerDropZone.tsx             оверлей перетягування, FileTrigger          (US2)
  ExplorerDialogs.tsx              діалоги, що зараз у кінці ExplorerBody
  ExplorerProcessStack.tsx         BulkTrash / AgentQueue / Restitch панелі
  ExplorerResults.tsx              результати пошуку в області списку           (US3)
apps/web/src/team/processing/ProcessScopeDialog.tsx                           (US4)
apps/web/src/team/workspace/SpaceHealth.tsx  (+ useSpaceHealth.ts)             (US5)
apps/web/src/components/ui/FileTrigger.tsx, Splitter.tsx                      (R5)
apps/web/src/styles/explorer.css, space-shell.css, accounts.css (замість team-accounts.css)
```

| Компонент | Відповідає за |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| `ExplorerToolbar` | Один рядок, одна primary, «…» з підписами на вузьких ширинах (через `Toolbar` з PR 13 і `DropdownMenu`) |
| `ContentList` | Заголовки-сортувальники, `aria-sort`, спільний стан `sort` з `SortMenu` |
| `FolderTree` + `Splitter` | Ширина 200–480, `persistedView.treeWidth`; `Drawer` нижче 1024 |
| `ExplorerResults` | `TeamCatalog` без власної оболонки, рендер `MaterialDetail` з `CatalogMaterialItem` |
| `ProcessScopeDialog` | `ProcessScope` = файл / виділені / тека / простір; межа 500; замінює `FolderScopeDialog` і вхід з меню простору |
| `useSpaceHealth` | Зведення сховища, realtime, агента, фонової роботи, оновлювача в `ok                                            | attention` |
| `check-design-tokens.mjs` | Список дозволених ширин `@media` |
| `tests/team-raw-controls.test.ts` | 0 сирих контролів у `team/` |

## Послідовність

1. **Фундамент** (T001–T008): база, ширини, винесення стилів провідника й шапки, `FileTrigger`, `Splitter`, тест сирих контролів (спершу як звіт, ворота — у фазі 9).
2. **Розділення `ExplorerShell`** (T009–T011): без зміни поведінки, ті самі тести.
3. **US1 + US2 — панель і список** (T012–T020). MVP релізу: провідник уже виглядає інакше.
4. **US3 — один пошук** (T021–T026).
5. **US5 — тиха шапка** (T027–T031).
6. **US9 — особисті сторінки й інструменти, видалення шиму** (T032–T040).
7. **US6 + US7 — акаунти, налаштування, учасники** (T041–T055).
8. **US8 + US4 — менеджер каталогів, діалоги, один діалог обробки** (T056–T064).
9. **Ворота й прибирання** (T065–T076): тест сирих контролів стає воротами, видалення CSS, a11y, перерахунок бюджету, CSP, findings, чекліст волонтерів.

Фази 4–8 незалежні одна від одної після фази 3 і можуть іти паралельними PR у `integration/1.6-polish`. Фаза 6 іде перед видаленням шиму у фазі 9.

## Викат

- Лише веб: `beta` → `next` → прод з релізом 1.6 за словом власника. Прапорців не треба: кожна фаза лишає продукт робочим. Виняток — US3 (пошук): прапорець `explorerInlineSearch` у `lib/feature-flags.ts` на час beta, бо це зміна звички.
- PR по фазах у `integration/1.6-polish`, як інші спеки 1.6. Не чіпати `release/1.5.9`, `next`, `beta`, `main`.
- Ручні перевірки — у `specs/_beta/1.6-volunteer-checklist.md`, розділ 070.

## Перевірка конституції

| Принцип                     | Як дотримано                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I. Типізовані межі          | Нових меж немає; `persistedView` перевіряє `treeWidth` наявним `usePersistedState` з межами                                                                                                                        |
| II. Єдине джерело контракту | `ProcessScope` замінює два наявні типи області; дії — з наявного реєстру (`useMaterialActionList`)                                                                                                                 |
| III. Найменші права         | Права не змінюються; дії, як і зараз, звіряються з `permissions` (024 T128 — лише читання доступне всім, хто читає)                                                                                                |
| IV. Ресурси агента          | Агент не змінюється                                                                                                                                                                                                |
| V. API та помилки           | Нових API немає; помилки збереження показуються словом (FR-025)                                                                                                                                                    |
| VI. Інтерфейс і стан        | Лише інвентар і токени; нові `FileTrigger`, `Splitter` — з контрактом і `/design`; ширини — токени + перевірка; `check-design-tokens`, `check-tailwind-classes`, `verify-styles` лишаються зеленими на кожній фазі |

Відхилень немає.
