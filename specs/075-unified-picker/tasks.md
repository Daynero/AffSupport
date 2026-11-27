# Задачі 075 · Одне вікно вибору

[Вимоги](spec.md) · [План](plan.md). Vitest — single-worker.

## Фаза 1 · Компонент

- [ ] T001 `components/ui/PickerDialog.tsx` + `picker-dialog.css`: список/плитка, пошук, toolbar, trail, leading, стани (завантаження/помилка/порожньо), нижня смуга, клавіатура, запам'ятовування подання; експорт з `ui/index.ts`.
- [ ] T002 Токени плитки в `tokens.css` (якщо бракує наявних).
- [ ] T003 Контракт `specs/021-design-system-redesign/contracts/components.md` (рядок Overlay) і показ на `/design`.

## Фаза 2 · Переведення (US1, US2)

- [ ] T004 `TaskAttachmentPicker` → `PickerDialog`: мініатюри, фільтр типу, `defaultView`/`viewKey`; виклики в `LaunchCreativePicker` (grid, `xl`) і завданнях (list).
- [ ] T005 `AddToTask` → `PickerDialog` single + «+ Нове завдання».
- [ ] T006 `TaskAccountPicker` — спроба переведення, підсумок у findings.md.

## Фаза 3 · Тести й гейти

- [ ] T007 `tests/picker-dialog.test.tsx`: подання й запам'ятовування, клавіатура, single/multiple, недоступні, порожній/помилка.
- [ ] T008 Оновити наявні тести вибору (вкладення, креатив запуску, додати в завдання).
- [ ] T009 Гейти: prettier, eslint, tsc, дизайн-гейти, пов'язані vitest; бета — перевірка в Chrome 1440×800 і на вузькому вікні.
