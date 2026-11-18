# Поточний стан переходів (спостереження з коду, 2026-11-18)

Зібрано з `1d496010` перед плануванням. Це факти, на які спирається спека,
а не план реалізації.

## Навігація

- Роутинг власний: `apps/web/src/lib/navigation.ts` (`navigateTo`,
  `useBrowserRoute`, `internalLink`). Зміна розділу загорнута у View
  Transition групи `wishly-page` (лише `.page-viewport`, каркас поза групою).
- Старий знімок лишається непрозорим, новий проявляється з підйомом на 8px
  (`styles.css`, `::view-transition-new(wishly-page)`), — так прибрали
  проблиск сот у 024.
- Пропуск переходу: немає API, зменшений рух, триває інший перехід або
  зміна теми (`is-theming`).
- **Межа простору — жорстка заміна**: `crossesTeamBoundary()` вимикає
  перехід між `/team…` та рештою, бо знімок старої сторінки накладався на
  простір і приймав кліки, а ширина каркаса змінюється.
- **Розділи простору — жорстка заміна**: `WorkspaceShell.tsx` перемикає
  вкладки `navigateTo(…, false, false)` — `animate: false` запровадили, бо
  перехід усієї сторінки на кожен клік читався як моргання.
- Два механізми появи: View Transition і клас `.page-enter`
  (`usePageEntrance`), розведені вручну, щоб не подвоювати рух.

## Лініві частини та заглушки

- `Root.tsx`: `ProtectedSoty` за `AuthLoadingScreen`; `HoneycombField` з
  `fallback={null}`.
- `ProtectedSoty.tsx`: `TeamSpace` з `fallback={<main className="page-container" />}`
  — порожній кадр на вході в простір.
- `TeamSpace.tsx`: `WorkspaceShell` з порожньою `section aria-busy`.
- `WorkspaceShell.tsx`: розділи (`LaunchSpace`, `ExplorerShell` та ін.) за
  порожнім `div aria-busy` або `fallback={null}`.
- Інші `fallback={null}`: `LaunchEditor`, `LaunchResult`, `SupportDialog`,
  `LazyCatalogRenameDialog`.

## Токени руху

`apps/web/src/styles/tokens.css`: `--motion-fast 150ms`, `--motion-base 220ms`,
`--motion-slow 300ms` (стеля), `--ease-out-curve`, `--ease-in-out-curve`,
аліаси `--dur-*`/`--ease-*`; під `prefers-reduced-motion` усе 1ms, крім
спінера. `styles.css` має 40 `@keyframes` і 82 декларації `transition:` —
частина з них поза інвентарем, їх треба звірити з реєстром переходів.

## Аналітика

Подій навігації чи якості переходу (час до вмісту, зсув розкладки, довгі
кадри) в `apps/web/src/analytics/events.ts` немає.
