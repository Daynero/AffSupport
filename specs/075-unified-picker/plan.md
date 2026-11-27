# План 075 · Одне вікно вибору

[Вимоги](spec.md) · [Задачі](tasks.md)

## Компонент `PickerDialog` (`apps/web/src/components/ui/PickerDialog.tsx`)

Оболонка без знань про простір. Будується на наявному `Modal` (`components/Modal.tsx`, новий розмір не потрібен — `xl` уже є в типі; додається стиль `modal-xl` для `layout="search"`, якщо його нема).

```ts
interface PickerItem {
  id: string;
  title: string;
  subtitle?: ReactNode; // шлях, статус, «уже додано», причина недоступності
  icon?: ReactNode; // значок типу
  thumbnailUrl?: string | null; // лише для плитки
  branch?: boolean; // тека: відкривається, не відмічається
  disabled?: boolean;
  disabledReason?: string;
}
interface PickerDialogProps {
  title: string;
  open: boolean;
  onClose(): void;
  search?: { value: string; onChange(v: string): void; placeholder: string; clearLabel: string };
  toolbar?: ReactNode; // фільтри (SegmentedControl тощо)
  trail?: ReactNode; // хлібні крихти
  views?: ('list' | 'grid')[]; // які подання доступні
  viewKey?: string; // ключ запам'ятовування подання
  defaultView?: 'list' | 'grid';
  items: PickerItem[];
  loading?: boolean;
  error?: { message: string; retry?(): void } | null;
  empty: { title: string; description?: string };
  selection: ReadonlySet<string>;
  mode: 'single' | 'multiple';
  onToggle(item: PickerItem): void;
  onOpen?(item: PickerItem): void;
  leading?: ReactNode; // рядок «+ Нове …» над результатами
  confirm: { label: string; disabled?: boolean; onConfirm(): void; loading?: boolean };
  cancelLabel: string;
  size?: 'lg' | 'xl';
}
```

- Список і плитка — одна множина `role="listbox"` (`aria-multiselectable` для multiple) з `role="option"`/`aria-selected`; роумінг фокусу стрілками (у плитці — по рядках сітки, кількість колонок читається з `getComputedStyle(grid).gridTemplateColumns`).
- Пробіл — відмітити, Enter — відкрити гілку / у single підтвердити, ⌘/Ctrl+Enter — підтвердити.
- Подання запам'ятовується: `localStorage['soty.picker.view.<viewKey>']`.
- Стилі `components/ui/picker-dialog.css`: сітка `repeat(auto-fill, minmax(var(--picker-tile-min), 1fr))`, плитка 4:3 з `object-fit: cover`, токени `--picker-tile-min`, `--picker-tile-radius` (через наявні `--radius-*`).

## Переведення

| Вікно                | Файл                                  | Що стається                                                                                                                                                                                                          |
| -------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Вкладення / креатив  | `team/tasks/TaskAttachmentPicker.tsx` | дані лишаються (теки, пошук, accept, unavailableWith), розмітка → `PickerDialog`; мініатюри через `useThumbnailSession`; фільтр типу; `views` = list+grid; `defaultView` від виклику (`LaunchCreativePicker` → grid) |
| Додати в завдання    | `team/tasks/AddToTask.tsx`            | діалог → `PickerDialog` single, рядок «+ Нове завдання» через `leading`                                                                                                                                              |
| Запуски для завдання | новий у 076                           | `PickerDialog` multiple                                                                                                                                                                                              |
| Акаунти              | `team/tasks/TaskAccountPicker.tsx`    | спроба переведення; підсумок у findings.md                                                                                                                                                                           |

## Ризики

- Тести, що шукають класи `team-task-picker-row` / `team-add-to-task-list`, і e2e-селектори — оновити на ролі (`option`).
- `layout="search"` тримає висоту результатів — для `xl` перевірити на 1440×800 (мінімум власника — MacBook Air M1).
