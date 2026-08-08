# Phase 0 Research: Ізольований UI-ребрендинг Soty

## Decision 1 — Фізично окремий review workspace

**Decision**: Створити `apps/soty-review` з власними entrypoint, Vite config і `dist`.

**Rationale**: Production `apps/web` монтує Auth, Agent, Support і Team providers, читає
root env, проксіює `/api` і є джерелом Cloudflare build. Окремий workspace без імпортів із
production graph дає перевірювану гарантію FR-002/FR-003/FR-006.

**Alternatives considered**: runtime feature flag, Vite mode або другий HTML entry у
`apps/web` (спільний dependency/env/deploy graph); реальні екрани з mock providers
(можливі module-level side effects і дрейф до реальної поведінки); Storybook (відсутній у
repo, component-centric); статичні screenshot-only макети (не доводять навігацію,
клавіатуру й локальні transition states).

## Decision 2 — Каталог і локальна state machine

**Decision**: Один typed catalog визначає surface IDs, state IDs, fixtures, coverage і
навігацію. Hash router використовує стабільні URL, а всі дії проходять через exhaustive
demo reducer.

**Rationale**: Це робить кожну правку адресованою як
`iteration/surface/state/element`, забезпечує direct-link без server rewrite і дає
машинну перевірку 100% coverage. Невідомий URL повертає до каталогу з поясненням.

**Alternatives considered**: JSX-екрани з прихованим локальним станом (немає аудиту
coverage); React Router (нова зайва залежність); browser history routes (потрібен fallback
server); справжні submit/file actions (порушують review boundary).

## Decision 3 — Поточний UI inventory

**Decision**: Каталог охоплює 12 customer-facing груп:

1. Auth entry: loading, login, callback, recovery, blocked/deleted, config error, profile
   onboarding.
2. Global shell: header, connection states, user menu, support, update, feature-lock і
   local-app overlays.
3. Home/tools: Team featured card і чотири tools у available/development/unavailable states.
4. Compressor: empty/populated/batch; job lifecycle; optimal/custom settings; image slots.
5. Landing Optimizer: queue, batch, phases, success/warning/error, compare і settings.
6. Landing Gallery: loading/welcome/catalog/viewer/search/render/error variants.
7. Transcription: model gate/download, queue lifecycle, transcript/translation/media modal.
8. Team lobby: loading/error/empty, ready/setup-incomplete/preparing cards.
9. Create space: name and folder steps, validation/OAuth/loading/error/resume.
10. Team workspace: catalog/search, previews, editing, provenance, process/operation states.
11. Team settings: Drive, members, invitations, permissions, ownership and audit states.
12. Account: loading/profile/save, invitations, release-status and sign-out.

Component showcase (buttons, controls, cards, modal, progress, badges, toast, logo, icons,
decoration) доповнює, але не замінює screen coverage. Marketing home, legal, admin-only,
installer/release assets, email/store/external integrations отримують explicit exclusion
records згідно зі scope специфікації.

**Rationale**: Інвентар звіряється з `Root.tsx`, `ProtectedSoty.tsx`,
`tool-registry.ts` та деревом team components. Кожна нова production surface до approval
ламає completeness check, доки її не класифіковано.

**Alternatives considered**: лише п'ять showcase screens (не виконує SC-001); включити
marketing/legal/admin (поза визначеним first-stage scope).

## Decision 4 — Нормативні та запропоновані tokens

**Decision**: `design-tokens.json` є єдиним джерелом Soty colors. Детермінований generator
розв'язує DTCG aliases у preview-scoped `--soty-*` CSS. Typography, spacing, radii,
elevation, motion і outcome colors позначаються як review proposals, бо JSON їх нормативно
не визначає.

**Rationale**: Ручне копіювання створює drift, а заміна чинних `--color-*` змінює Soty.
Generated output можна перевірити на stale content, unresolved/cyclic aliases і literals.

**Alternatives considered**: reuse/replace `apps/web/src/styles.css`; ручні duplicate
variables; direct primitive colors у компонентах.

## Decision 5 — Контраст і доступність на фактичній поверхні

**Decision**: Перевіряти кожну computed foreground/background/border/focus комбінацію,
не лише primitive palette. Normal text має ≥4.5:1, large text і meaningful UI graphics/
focus ≥3:1; status завжди має text/icon/shape.

**Rationale**: Аудит виявив ризики: light muted text 3.54–3.85:1, dark secondary action
3.61:1, honey active on white 2.07:1, default borders близько 1.4–1.9:1. Тому light normal
metadata використовує `text.secondary`, focus — opaque/dual 3px ring, honey CTA — dark
foreground, а слабкі borders не є єдиною межею control. Success/warning/error не
перефарбовуються довільно у purple/honey.

**Alternatives considered**: вважати всі token pairs автоматично AA; покладатися лише на
axe; використовувати color alone для status/disabled.

## Decision 6 — Theme, motion і responsive review

**Decision**: Theme scope — `[data-soty-theme=light|dark]`, окремо від production
`data-theme`. URL має пріоритет для deterministic screenshots, потім system preference.
Reduced-motion rule прибирає декоративні loops/transitions і залишає текстовий стан.
Layout reflows до 320 CSS px; decoration зникає раніше за зміст.

**Rationale**: Production theme використовує global DOM/storage/event і Soty meta
colors; reuse порушив би ізоляцію. Viewport emulation не дорівнює 200% browser zoom, тому
потрібна і automated reflow matrix, і ручна zoom-перевірка.

**Alternatives considered**: production theme hook; fixed card widths; один desktop
screenshot; animation як єдина ознака progress.

## Decision 7 — Перевірка ізоляції та approval

**Decision**: Playwright дозволяє лише review origin/static/HMR, клікає щонайменше 50
`data-demo-action` controls і fail-ить на зовнішньому/API/analytics/agent request. Окремі
checks сканують imports, browser globals, Soty/Soty brand text і production build output.
Screenshot matrix та axe є review evidence, але письмовий owner approval є єдиним SC-010
gate.

**Rationale**: Статичне твердження «mocked» не доводить відсутність side effects;
автоматизований deny-by-default browser audit дає повторюваний доказ. Pixel baseline може
лише виявити change, не схвалити design.

**Alternatives considered**: ручний network inspection; snapshot approval як product
approval; автоматичне включення preview tests у production deploy.
