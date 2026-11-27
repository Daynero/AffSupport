# Задачі 075 · Одне вікно вибору

[Вимоги](spec.md) · [План](plan.md). Vitest — single-worker.

## Фаза 1 · Компонент

- [x] T001 `components/ui/PickerDialog.tsx` + `picker-dialog.css`: список/плитка, пошук, toolbar, trail, leading, стани (завантаження/помилка/порожньо), нижня смуга, клавіатура, запам'ятовування подання; експорт з `ui/index.ts`.
- [x] T002 Токени плитки в `tokens.css` (якщо бракує наявних).
- [x] T003 Контракт `specs/021-design-system-redesign/contracts/components.md` (рядок Overlay) і показ на `/design`.

## Фаза 2 · Переведення (US1, US2)

- [x] T004 `TaskAttachmentPicker` → `PickerDialog`: мініатюри, фільтр типу, `defaultView`/`viewKey`; виклики в `LaunchCreativePicker` (grid, `xl`) і завданнях (list).
- [x] T005 `AddToTask` → `PickerDialog` single + «+ Нове завдання».
- [x] T006 `TaskAccountPicker` — не переведено, причина в findings.md.

## Фаза 3 · Тести й гейти

- [x] T007 `tests/picker-dialog.test.tsx`: подання й запам'ятовування, клавіатура, single/multiple, недоступні, порожній/помилка.
- [x] T008 Оновити наявні тести вибору (вкладення, креатив запуску, додати в завдання).
- [ ] T009 Гейти: prettier, eslint, tsc, дизайн-гейти, пов'язані vitest; бета — перевірка в Chrome 1440×800 і на вузькому вікні.
      **⚠ ВРУЧНУ НЕ ВІДТЕСТОВАНО** (2026-11-27): автотести й гейти зелені, власник ще не перевіряв на беті. Я лише відкрив вибір файлів у плитці на беті; вузьке вікно й вибір креативу в запуску не дивились.
