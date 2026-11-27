# Задачі 074 · Оновлення на видноті

[Вимоги](spec.md) · [План](plan.md). Vitest — single-worker.

## Фаза 1 · Одне джерело правди

- [x] T001 `updates/UpdateCenter.tsx`: провайдер з одним `useNativeAppUpdate`, legacy-статусом і `offer` (фази, `required`, `fraction`); `start()` (native prepare + авто-accept на `attemptId`; installer — програмне скачування або вікно вибору); `openDetails()`.
- [x] T002 `ProtectedSoty.tsx`: обгорнути вміст `AgentProvider` у `UpdateCenterProvider`.
- [x] T003 `NativeAppUpdateNotice` бере `state/act/refresh/pending/error` з провайдера, плашка — лише для fallback-ів (rollback / без нативного дескриптора); вікно подробиць без змін.
- [x] T004 `ReleaseUpdateNotice`: legacy-плашка лише для повернення на стабільну (051).

## Фаза 2 · Кнопка в шапці (US1)

- [x] T005 `updates/HeaderUpdateButton.tsx`: стани available / downloading (кільце) / waiting / installing / attention / ready; підпис на широкому екрані; `data-update-button`; сяйво за подією.
- [x] T006 `App.tsx` Header: кнопка після `ConnectionBadge`.
- [x] T007 Токени `--motion-genie`, `--ease-genie`, `--motion-update-glow`, `--shadow-update-glow` (+ reduced-motion); `update-center.css`.

## Фаза 3 · «Що нового» і джин (US2)

- [x] T008 `updates/release-highlights.ts`: запис для версії (uk/en: заголовок, рядки, картинка) і запасний варіант з `localizedReleaseSummary`.
- [x] T009 `updates/WhatsNewOverlay.tsx`: один раз на `buildId`, умови показу (не під час онбордингу/оновлення/rollback), «Оновити» → `start()` + згасання, «Пізніше»/Esc/X/затемнення → джин → сяйво; фокус повертається на кнопку.
- [x] T010 `updates/genie.ts`: WAAPI з токенів, reduced-motion, запасне згасання, якщо цілі нема або WAAPI впав.
- [x] T011 Ілюстрація оновлення (SVG-компонент на `currentColor` і токенах).

## Фаза 4 · Тексти, тести, гейти

- [x] T012 Тексти uk/en.
- [x] T013 `tests/update-center.test.tsx`: кнопка з'являється за пропозицією й не зникає після «Пізніше»; натискання стартує prepare і авто-accept один раз; installer — скачування; вікно один раз на buildId; «Пізніше» → подія сяйва; reduced-motion; rollback — стара плашка.
- [x] T014 Оновити наявні тести плашок/меню, що зачеплені.
- [x] T015 Гейти: prettier, eslint, tsc (web + tests), `check-design-tokens`, `check-tailwind-classes`, `verify-styles`, пов'язані vitest.
- [ ] T016 Бета: перевірити в Chrome на беті (стара збірка агента проти нового маніфесту), записати в findings.md.
