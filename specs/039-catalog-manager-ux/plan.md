# Implementation Plan: Зручний менеджер оновлення каталогів

**Date**: 2026-10-18 | **Spec**: [spec.md](spec.md) | **Status**: Ready for implementation

## Summary

Перенести параметри змісту оновлення з глобального стану в незалежний профіль кожного каталогу зі збереженням чинних розкладів. Додати підтверджену історію спроб і явні часткові/невідомі результати. Перебудувати менеджер навколо швидко сканованого рядка та деталей каталогу, масових patch-дій, стану застарілих даних і швидкого списку. Повний діагностичний ланцюг є частиною готовності.

## Technical Context

**Language/Version**: TypeScript strict, PostgreSQL SQL, React.\
**Primary Dependencies**: чинний HeroUI/React Aria інвентар, Supabase RPC/Realtime, Google Drive seam, локальний agent для restitch.\
**Storage**: наявні `team_catalog_updaters`, `team_catalog_updater_items`, `team_product_catalogs`; нові поля профілю й історія спроб.\
**Testing**: Vitest single worker, Supabase database tests, `npm run verify`, beta packaged smoke.\
**Target**: web + Supabase worker; agent тільки для кореляції й restitch.\
**Scale**: 500 каталогів у менеджері; до трьох паралельних worker items уже є.\
**Performance**: SC-003, стабільний scroll anchor, без повного 5-секундного refetch списку.

## Constitution Check

- Типи профілю, результату й коди помилок — у shared; недовірені RPC payload перевіряються на межі.
- Доступ до зміни перевіряється server-side; секрети Drive не потрапляють у сигнали.
- Realtime використовує чинний team seam; нового незалежного polling owner не створювати.
- UI використовує `apps/web/src/components/ui/`, токени й `docs/DESIGN.md`.
- Локальне restitch залишається в наявному PowerGovernor seam; 100% поведінка незмінна.
- Версії та release contract не змінюються лише для цієї роботи. Порушень конституції не виявлено до й після дизайну.

## Phases

1. **Дані та сумісність**: локальна міграція копіює спільні значення в кожен профіль; claim читає профіль і фіксує snapshot. Транзакційні version checks; rollback contract і перевірка чинних розкладів.
2. **Надійна спроба**: ідентифікатор, етапи, verification після Drive write, частковий результат, ідемпотентний retry. Спершу відтворити timeout/partial у тестах.
3. **Read model та UI**: summary й історія, деталі, окремі дії вимкнути/скасувати/видалити, mixed bulk, фільтри, stale state, адаптація 390 px.
4. **Швидкодія й діагностика**: один ownership шляху refresh, віконний рендер/пагінація за потреби вимірів, події від джерела до CLI та coverage inventory.
5. **Приймання**: сценарії `quickstart.md`, два кола аналізу артефактів уже виконуються в цьому пакеті; після реалізації — verify, beta й фактична UX оцінка.

## Project Structure

`apps/web/src/team/catalog-updater/` — рядок, редактор і запити; `apps/web/src/api/team.ts` — перевірений boundary; `packages/shared/src/team/` — профіль/спроба; `supabase/migrations/` і `supabase/functions/catalog-updater/` — зберігання й worker; `scripts/analytics/` — діагностика; `tests/` і `supabase/tests/database/` — регресії. Контракти наведено в [contracts/catalog-manager.md](contracts/catalog-manager.md), рішення в [research.md](research.md), модель у [data-model.md](data-model.md).

## Risks and gates

- Найвищий ризик — повтор після невизначеної відповіді Drive; gate: автоматичний тест без подвійного приросту й видалення активного відео.
- Міграція активних розкладів; gate: порівняння знімків до/після, включно з off, pending і restitch.
- Діагностика повинна відрізняти успіх, частковий результат і невідомий delivery; gate: CLI сценарії та inventory без фальшивого `covered`.
- UI продуктивність; gate: вимір на 500 рядках та керування на 390 px.
