# Contracts: Спрощений покроковий інтерфейс командного простору

This feature exposes **UI contracts** — the observable behaviour of the redesigned team-space
surfaces — not new backend interfaces. It adds **no** RPC, Edge Function, table, or shared
protocol change. Every server interaction reuses the existing `apps/web/src/api/team.ts`
wrappers and the 001 endpoints they call.

The contracts are grouped by surface:

- [`navigation-and-lobby.md`](./navigation-and-lobby.md) — the `/team` resolver, the space
  lobby, the entered-space cache, and "Change space".
- [`create-space-wizard.md`](./create-space-wizard.md) — the linear name → folder → done flow,
  its required-field gates, and setup-incomplete handling.
- [`workspace-shell-and-disclosure.md`](./workspace-shell-and-disclosure.md) — the content-
  first shell, the `SpaceSettings` secondary surface, and progressive search/filters.
- [`reused-backend.md`](./reused-backend.md) — the exact 001 endpoints reused, asserting no
  contract change.

**Conventions**: existing stable `TeamApiError` codes are surfaced through i18n by branching on
the code (never the message). New user-facing strings are compile-checked `TranslationKey`s
added to both `en` and `uk`. All state is modelled as string-literal unions / discriminated
results (Principle I). No new `any`, no polling, no inline static styles (Principle VI).
