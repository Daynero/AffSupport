# Implementation Plan: Простий менеджер каталогів

**Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

## Approved implementation addendum

[icon-controls/plan.md](icon-controls/plan.md) supersedes the individual draft/Save model below: five inline toggles and inline schedule share immediate versioned persistence with live details. Bulk and defaults retain explicit Apply/Save. Final implementation evidence and reviews: [icon-controls/acceptance.md](icon-controls/acceptance.md). The owner narrowed testing to desktop only.

## Summary

Перебудувати менеджер як читабельний список з окремою панеллю налаштувань. Зберегти серверні профілі, версії, права та планувальник 039. Винести шаблон у налаштування простору, додати захист чернеток і правдиву історію.

## Technical Context

TypeScript strict, React, Vite, HeroUI inventory, Supabase team API/realtime. Existing storage and profile version contracts; no new database schema. Vitest/Testing Library for regression, repository verify gates, live beta for visual inspection. Desktop and mobile browser, 2/50/500 catalogs. UI feedback <=100ms, search <=300ms, initial list <=2s on documented device; external Drive work measured separately.

## Constitution Check

Pre-design and post-design PASS: shared contracts retained; least-privilege team permissions; no release/version changes; no child processes added; existing API errors; component inventory and token styles; existing realtime owner; bounded privacy-safe analytics. No new dependencies or schema reset.

## Project Structure

- apps/web/src/team/catalog-updater/: manager, profile/bulk editor, history, defaults editor, diagnostics helper.
- apps/web/src/team/settings/: existing space settings integration.
- apps/web/src/styles.css and i18n.ts: responsive token layout and both languages.
- scripts/analytics/: existing catalog diagnostics and coverage registry.
- tests/: focused catalog regressions.

## Execution

Research current contracts, then US1 list/filter composition, US2 single draft panel, US3 truthful history/retry, US4 explicit bulk panel, US5 space defaults. Integrate diagnostics and run focused tests and npm run verify. Preserve unrelated working-tree changes. Human sessions and network performance targets remain explicitly unverified until measured.

## Complexity Tracking

No constitutional exceptions. Existing legacy defaults setters require verification of future-only effect before reuse.
