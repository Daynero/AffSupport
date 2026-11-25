# Tasks: Перезашивка як стрічка ролика (071)

## Фаза 1 — Дослідження

- [x] T001 З'ясувати одиниці фінальної тривалості (хвилини, 1–60) — spec.md «Одиниці».
- [x] T002 Перевірити, що `restitch` на відео без зашивки = `stitch` (`planStitch`), і хто читає `operation` (агент, `restitch-root`, нативний контролер) — spec.md R1.
- [x] T003 Знайти адресу вкладки (`?settings=1&tab=restitch`, `TEAM_SETTINGS_TABS`) — не змінювати.
- [x] T004 Записати контракт вбудованих картинок для агента захисту — findings.md.

## Фаза 2 — Модель і компонент

- [x] T010 `restitch-timeline-scale.ts`: хвилини ↔ режим, прив'язка до пресетів, кроки клавіатури, підписи.
- [x] T011 `RestitchTimeline.tsx`: сегменти-кнопки, розрив осі, шкала, ручка `role="slider"` (вказівник + клавіатура), повтор фінальної картинки, зона діапазону, reduced-motion.
- [x] T012 Стилі стрічки лише на токенах; 1440 і 390 px.
- [x] T013 Тест `tests/restitch-timeline.test.tsx`: клавіатура, aria-valuetext, прив'язка, вимкнений слот.

## Фаза 3 — Розділ простору

- [x] T020 `restitch-form.ts`: форма, дефолти «з коробки», `builtinSlot()`.
- [x] T021 `RestitchSlotPanel.tsx`: перемикач, мініатюри/стандартна картинка, вибори Drive, тривалість початку.
- [x] T022 `RestitchFitPicker.tsx`: три кадри.
- [x] T023 `RestitchDefaultsSection.tsx`: без режимів, нова композиція, стан «вимкнено», примітка про старий режим, режим читання для учасника.
- [x] T027 Читати перемикачі з сирого рядка (`restitch/restitch-row.ts`, `get_restitch_defaults`), бо ефективні налаштування з 20261224170000 переписують перемикачі для старих агентів; для особистих налаштувань учасника — відновлення з маркера `builtin` (`formOf`).
- [x] T028 Множина хвилин для скрінрідера (`restitchMinutesKey` в `i18n.ts`): «54 хвилини».
- [x] T024 Тексти `uk.ts`/`en.ts`.
- [x] T025 Стандартні картинки — **скасовано для UI**: v1 від агента захисту (`/restitch/soty-restitch-{start,end}.v1.png`, рішення власника: біле тло, чорний play / стрілка вниз); UI бере шляхи з `RESTITCH_BUILTIN_SCREENS`.
- [x] T026 Оновити `tests/team-restitch-section.test.tsx` (режимів більше немає — свідомо).

## Фаза 3б — Відгуки власника

- [x] T040 Тривалість — лише повзунок з двома ручками на стрічці; прибрано перемикач, поле й пресети (`RestitchTimeline`, `restitch-timeline-scale.ts`, `restitch-form.ts`).
- [x] T041 Міграція `20261224271000_restitch_defaults_duration_range.sql` (адитивна) + `TeamRestitchDefaults.finalDurationRangeSeconds` у shared; накатано на бету через psql.
- [x] T042 Картка «Перезашиті відео — за секунди» (`RestitchPrepareCard.tsx`, `useRestitchReadiness.ts`), поточне відео й залишок у `useRestitchPreparation`.
- [x] T043 Тести: `restitch-prepare-card.test.tsx`, `restitch-readiness.test.tsx`, оновлені `restitch-timeline.test.tsx`, `team-restitch-section.test.tsx`.
- [x] T045 Перемикачі початку й фіналу — на кліпах стрічки; дві картки «Початок»/«Фінал» поруч замість панелі обраного кліпу; кліп відео — не кнопка.
- [ ] T044 (агент, окремо) прогрес завантаження в межах файлу при підготовці; запис prep після перезашивки в каталозі/запусках; власний розіграш проміжку агентом; автоматична фонова підготовка — findings.md.

## Фаза 4 — Перевірка

- [x] T030 tsc web, eslint, prettier на змінених; гейти дизайну; vitest single-worker на зачеплених тестах.
- [x] T031 Chrome 1440×800 і 390 px: перетягування, клавіатура, вибір картинок, збереження, перезавантаження.
- [x] T032 DESIGN.md: запис про `RestitchTimeline`.
- [ ] T033 Коміт лише своїх файлів, пуш у `070-explorer-cabinet-polish` і `integration/1.6-polish`.
