# Implementation Plan: Ізольований UI-ребрендинг Soty

**Branch**: `003-rebrand-soty-ui` | **Date**: 2026-08-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-rebrand-soty-ui/spec.md`

## Summary

Перший етап ребрендингу створює окремий локальний React/Vite workspace
`apps/soty-review`, який відтворює чинні customer-facing in-app поверхні як каталог
детермінованих демонстраційних екранів і станів. Він не імпортує production web-app,
Supabase, agent/API, analytics або реальні дані, не входить до production build/deploy та
виконує взаємодії лише через локальний типізований reducer.

Каталог є єдиним джерелом істини для стабільних screen/state IDs, покриття станів,
навігації й review-посилань. Нормативний `design-tokens.json` генерує ізольовані
`--soty-*` CSS variables для світлої й темної тем. План закінчується локальним візуальним
approval gate; підключення функціональності, заміна Soty UI та rollout не входять до
цього етапу.

## Technical Context

**Language/Version**: TypeScript 5.9.3, `strict: true`, ES2022/ESM; React 19.2.7.

**Primary Dependencies**: Окремий Vite 8.1.5 + React workspace; наявні Vitest/jsdom і
Testing Library для DOM-тестів; прямо задекларований у review workspace Playwright/Chromium
1.62.1 для ізоляційної, responsive та screenshot-перевірки. `@axe-core/playwright`
додається як pinned dev dependency для автоматизованого accessibility smoke-check, але не
замінює ручну WCAG-перевірку.

**Storage**: N/A. Усі fixtures — статичні локальні TypeScript literals. Theme/state
кодуються в hash URL; cookies, IndexedDB, production local/session storage заборонені.

**Testing**: Центральні `tests/*.test.ts(x)` з Vitest і jsdom; окремий Playwright harness
для ≥50 демонстраційних взаємодій, network deny-list, screenshot matrix, keyboard,
reduced-motion і axe. Ручна перевірка реального 200% browser zoom та візуального approval.

**Target Platform**: Лише локальний браузер на loopback: dev `127.0.0.1:5174`, preview
`127.0.0.1:4174`. Не Cloudflare Pages і не desktop package.

**Project Type**: Новий ізольований frontend workspace всередині наявного npm-workspaces
monorepo.

**Performance Goals**: Каталог і перший екран стають інтерактивними без network/data
очікування; перемикання локального стану/теми не створює мережевих запитів; анімації
залишаються плавними на підтримуваних desktop/mobile viewport і повністю деградують до
статичного стану при reduced motion.

**Constraints**:

- Жодних імпортів із `apps/web/src`, `@video-compressor/shared`, Supabase, agent/API або
  analytics; жодних `fetch`, XHR, `sendBeacon`, application WebSocket/EventSource, native
  file picker, cookies чи persistent browser storage.
- Vite має `envDir: false`, окремий `dist`, no proxy, loopback-only host і CSP; дозволене
  з'єднання лише для власних static assets та Vite HMR на loopback.
- Root `build`, `build:web`, `deploy:web`, packaging, release version і stable manifest не
  включають review workspace.
- `design-tokens.json` — єдине нормативне джерело кольорів; generated CSS перевіряється на
  drift, unresolved/cyclic aliases і заборонені literals.
- Semantic outcome roles для success/warning/error, яких немає в поточному token set, є
  review proposals і не можуть самовільно використовувати purple/honey.
- Мінімальна планова ширина — 320 CSS px; реальний 200% zoom перевіряється вручну.
- Візуальні baseline-зміни не є approval; письмове рішення власника залишається окремим
  обов'язковим gate.

**Scale/Scope**: 12 груп customer-facing in-app поверхонь плюс component showcase;
canonical стани `default`, `loading`, `empty`, `success`, `error`, `active`,
`confirmation`, `disabled`; light/dark, uk/en-long-copy, 5 viewport sizes, reduced motion
і review iteration `soty-ui-r01`. Marketing, legal, admin-only, installer/release assets,
email/store/external integration surfaces мають явні exclusion records.

## Constitution Check

_GATE: evaluated before research and re-checked after Phase 1 design._

| Principle                                    | Gate and post-design verdict                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Type-safe contracts**                   | Catalog, route parser, fixtures, actions and per-surface state are closed discriminated unions; URL input is validated; exhaustive reducers use `never`; no unvalidated casts or `any`. **PASS**        |
| **II. One source of truth**                  | Release/protocol constants are untouched. `design-tokens.json` is canonical and generated CSS is drift-checked; one catalog drives navigation and coverage. Review iteration has one constant. **PASS** |
| **III. Security/least privilege**            | Separate app has no auth/data/network integration, uses loopback-only servers, no proxy/env, restrictive CSP and automated forbidden-request checks. **PASS**                                           |
| **IV. Child-process/resource orchestration** | No product child-process code changes. Screenshot harness uses the existing pinned Chromium family through Playwright and always closes browser/context in `finally`. **PASS (limited test tooling)**   |
| **V. HTTP/error conventions**                | Review app exposes no API and calls none; errors are local discriminated fixture states. **PASS (N/A)**                                                                                                 |
| **VI. Frontend composition/state**           | Small functional components, preview-local reducer/context, CSS classes and scoped custom properties; no production provider reuse, prop-drilled i18n or data-fetching layer. **PASS**                  |

Additional gates: `npm run format:check`, `npm run lint`, `npm test`, `npm run build:web`
remain green; review-specific type/build/isolation/a11y/screenshot checks run separately.
The constitution's Soty identity remains unchanged because Soty is an inactive review
artifact and internal package scope stays `@video-compressor/*`. Any later production
replacement is blocked on a separate plan and explicit governance decision.

**Post-design result: PASS. No unresolved `NEEDS CLARIFICATION` and no constitution waiver.**

## Project Structure

### Documentation (this feature)

```text
specs/003-rebrand-soty-ui/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── design-tokens.json
└── contracts/
    ├── README.md
    ├── review-catalog.md
    ├── isolation-boundary.md
    └── visual-system-and-approval.md
```

### Source Code (repository root)

```text
apps/soty-review/
├── index.html                         # review-only CSP and root
├── package.json
├── tsconfig.json
├── vite.config.ts                     # loopback, envDir:false, no proxy, own dist
├── public/                            # synthetic/local assets only
├── scripts/
│   ├── generate-tokens.mjs            # design-tokens.json → generated CSS
│   └── verify-review.mjs              # browser isolation/a11y/screenshot matrix
└── src/
    ├── main.tsx
    ├── ReviewApp.tsx
    ├── generated/soty-tokens.css
    ├── styles.css
    ├── components/                    # Soty-only primitives and decorative SVG
    ├── review/
    │   ├── model.ts                   # discriminated catalog/action/state contracts
    │   ├── catalog.ts                 # single surface/state coverage registry
    │   ├── router.ts                  # validated hash parser/serializer
    │   ├── reducer.ts                 # local demo transitions only
    │   └── fixtures/                  # immutable synthetic content
    └── screens/
        ├── auth/                      # login and customer account-entry states
        ├── shell/                     # topbar, global overlays and home
        ├── compressor/
        ├── landing-optimizer/
        ├── landing-gallery/
        ├── transcription/
        ├── team/                      # lobby/create/workspace/settings states
        └── account/

tests/
├── soty-review-catalog.test.ts
├── soty-review-routing.test.ts
├── soty-review-reducer.test.tsx
├── soty-review-isolation.test.ts
├── soty-review-tokens.test.ts
└── soty-review-accessibility.test.tsx
```

**Structure Decision**: Новий workspace є фізичною approval-boundary. Він копіює
поведінкові форми як demo-only компоненти, але не імпортує живі компоненти або providers.
Це сильніше за feature flag/Vite mode у `apps/web` і не дозволяє Soty-коду випадково
потрапити в production `apps/web/dist`.

## Complexity Tracking

Constitution violations відсутні. Окремий workspace є необхідною ізоляційною межею, а не
новим production application tier; його build/dependencies не входять до release/deploy.
