# Contract: рух і навігація (web)

## `navigateTo(path, options?)`

```ts
type NavigateOptions = {
  replace?: boolean;          // default false
  motion?: 'page' | 'section' | 'none'; // default 'page'
  prepare?: () => Promise<unknown>;     // завантажити чанк/дані до коміту
};
navigateTo(path: string, options?: NavigateOptions): void;
// сумісність: navigateTo(path, replace?, animate?) — animate=false ≡ motion 'none'
```

Гарантії:
1. `BEFORE_NAVIGATION_EVENT` скасовує навігацію до будь-яких змін (як зараз).
2. `prepare` чекає максимум `WAIT_BEFORE_SKELETON_MS` (300). Старий екран
   видно; нова навігація скасовує очікування (токен).
3. Коміт: `pushState/replaceState` → (`motion≠none`) перехід браузера з
   `flushSync(apply)`; прокрутка й фокус застосовуються всередині коміту.
4. Нова навігація під час анімації викликає `skipTransition()` у поточної.
5. Миттєвий коміт (без анімації): зменшений рух, прихована вкладка, режим
   `lite` (лише `page`), активна зміна теми, браузер без API (тоді
   `ui-content-enter` на новому вмісті).
6. `motion: 'none'` не чіпає прокрутку й фокус.
7. `popstate` — завжди `page`/`section` за реєстром, відновлює прокрутку
   запису; скасування повертає адресу (як зараз).

## View-transition імена

| Клас на `<html>` | Елемент | Ім'я | Анімація |
|------------------|---------|------|----------|
| `wishly-page-transition` | `.page-viewport` | `wishly-page` | old 1→0, new 0→1 + 4px, `--motion-base`, `--ease-out-curve` |
| `wishly-page-transition` | `.topbar-start`, `.topbar-end` | `wishly-topbar-start/end` | group-морф позиції, `--motion-base` |
| `wishly-section-transition` | `.team-space-shell-body` | `wishly-section` | old 1→0, new 0→1 + 2px, `--motion-fast` |
| будь-який з двох | `root` | — | `animation: none` |

Під `prefers-reduced-motion` усі ці псевдоелементи — `animation: none`.

## Оверлеї

`usePresence(open, durationVar)` → `{ mounted, state: 'open' | 'closing' }`.
`Modal`/`Drawer`/`Popover`/`DropdownMenu` (крім `frequent`) ставлять
`data-state="closing"` на поверхню й тло; закриття — `--motion-fast`, дзеркальне;
`pointer-events: none` під час закриття; `.ui-overlay.is-nested` без власного тла.

## Заготовки

`RouteSkeleton variant="tool" | "settings" | "lobby" | "list" | "tiles" | "board"`
— з `Skeleton`; показ через `animation-delay: var(--wait-before-skeleton)`;
`aria-busy` і підпис для читача екрана.
