# Implementation Plan: Єдиний щоденний облік грошей агентів

**Branch**: поточна Git-гілка `fix/drive-unverified-pilot`; feature ID `027-agent-daily-spend`.
**Date**: 2026-10-03 | **Spec**: [spec.md](spec.md)
**Input**: `specs/027-agent-daily-spend/spec.md`, FR-001–FR-031.
**Status**: Implementation in progress; виконані та залишкові задачі відмічено в [tasks.md](tasks.md). Локальні міграції застосовано, production не змінювався.

## Summary

Розширити Акаунти одним денним фінансовим режимом із полями «Залишок», «Поповнено», «Спенд», спільною датою та місячним оглядом. Історичне розміщення агента визначає соц для кожної дати; поточний account_id лишається вказівником для звичайного списку та завдань. Кожна зміна фінансового поля має версію й незмінний журнал. Excel формується на сервері з одного авторизованого знімка.

USD і збереження старих сум за історичним соцом залишаються робочими припущеннями специфікації. План не вводить конвертацію валют, синхронізацію з рекламними кабінетами чи облік окремих банківських платежів.

## Technical Context

**Language/Version**: TypeScript 5.9, strict ESM, React 19; SQL для наявного Supabase/PostgreSQL; Edge Functions у чинному середовищі проєкту.

**Primary Dependencies**: чинні React, HeroUI v3 / React Aria, Supabase client; локальний XLSX writer `supabase/functions/_shared/xlsx.ts` із сумісним розширенням на кілька аркушів. Нових runtime-залежностей не потрібно.

**Storage**: PostgreSQL: значення за агентом/датою/показником, періоди розміщення, журнал, знімок старих полів і квитанції повторюваних операцій.

**Testing**: Vitest, jsdom, PGlite для контрактів SQL; реальний локальний PostgreSQL для конкурентності/RLS; Playwright через чинну перевірку Акаунтів; незалежне читання XLSX і відкриття файлу в Excel.

**Target Platform**: web на macOS/Windows, вузькі екрани; фінанси не залежать від запущеного локального агента.

**Project Type**: розширення наявного монорепозиторію web + shared + Supabase.

**Performance Goals**: перемикання періоду p95 ≤2 с; Excel p95 ≤10 с для 100 соц/500 агентів/31 дня. Вимірювати також перенесення між різними соцами; повторне повернення до того самого соцу не додає колонку.

**Constraints**: жодного прихованого автоперенесення сум, втрати історії, подвійного підсумовування, recurring polling або доступу між просторами. Формат грошей точний, суми в транспорті — десяткові рядки.

**Scale/Scope**: один простір за запит; день або один місяць для звіту; журнал сторінками по 50 записів. Максимум 100 записів на сторінку журналу. Весь архів не завантажувати в Accounts.

## Constitution Check

| Принцип                         | До research | Після design / спосіб виконання                                                                                                 |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| I. Типізовані контракти         | PASS        | Валідатори дат, десяткових сум, версій та результатів у shared; зовнішні дані unknown                                           |
| II. Release contract            | PASS        | Версії, маніфест, локальний протокол не змінюються на етапі плану; реалізація проходить штатні release gates                    |
| III. Least privilege            | PASS        | RLS, composite tenant keys, private.can, лише RPC-записи, security definer із порожнім search_path; експорт під JWT користувача |
| IV. Process/resource discipline | PASS        | Нових child processes або локальних важких задач немає                                                                          |
| V. Error conventions            | PASS        | Існуючий TeamApiError, стабільні коди; Edge HTTP status узгоджені з причинами                                                   |
| VI. UI/state discipline         | PASS        | UI inventory і tokens; один власник accounts realtime, bounded rereads, без polling; виділені фінансові компоненти              |

Винятків із конституції немає. Gate повторно перевірено після data model та contracts. Production-дії не є частиною цього планування.

## Project Structure

### Documentation (this feature)

- `plan.md` — порядок реалізації й gates.
- `research.md` — рішення та перевірені точки інтеграції.
- `data-model.md` — сутності, транзакції, обмеження та перехід зі старого обліку.
- `contracts/finance.md` — RPC, типи, помилки, експорт.
- `contracts/ui.md` — стани екрана й поведінка календаря.
- `quickstart.md` — локальна перевірка результату.
- `tasks.md` — підготовлена послідовність реалізації та перевірок.

### Source Code (repository root)

Наявні точки інтеграції:

- `packages/shared/src/team/accounts.ts`, team exports та згенеровані DB types.
- `apps/web/src/api/team.ts` — делегування новим типізованим wrappers.
- `apps/web/src/team/accounts/{AccountSpace,AccountGroup,AgentRow,AgentMoney}.tsx`.
- `apps/web/src/team/accounts/useAccounts.ts` — чинна підписка та кеш.
- `apps/web/src/components/ui/`, `apps/web/src/styles/tokens.css`, локалізація.
- `supabase/functions/_shared/{auth,cors,xlsx}.ts`.
- `supabase/migrations/`, `supabase/tests/`, `supabase/config.toml`.
- `tests/team-agent-money-sql.test.ts`, `tests/team-accounts*.test.*`, `tests/product-catalog-xlsx.test.ts`.
- `scripts/check-accounts-layout.mjs`, migration rollback documentation.

Заплановані нові модулі:

- `packages/shared/src/team/agent-finance.ts` — формат грошей, DTO, guards, правила звіту.
- `apps/web/src/api/team-finance.ts` — RPC та binary export wrapper.
- `apps/web/src/team/accounts/finance/` — FinanceToolbar, DailyFinanceFields, MonthlyFinanceSummary, FinanceHistoryDrawer, MoveAgentDialog, LegacyFinanceReview, useAgentFinance, useFinancePeriod.
- `supabase/functions/team-finance-export/{index,handler}.ts`.
- `supabase/functions/_shared/finance-workbook.ts`.
- Нові forward migrations і `tests/team-agent-finance*.test.ts(x)`.

**Structure Decision**: фінансовий модуль усередині Акаунтів; жодного нового застосунку чи паралельного бекенду. Не роздувати AccountSpace і api/team.ts: залишити там композицію та делегування.

## Implementation Sequence

### 1. Контракти й точна арифметика

Реалізувати DTO/guards та гроші як cents bigint усередині обчислень і decimal strings на межі. Дати — YYYY-MM-DD, часові позначки — UTC; timezone передається окремо для визначення «сьогодні» та при створенні агента; RPC створення, browser wrapper і форма мають підтримати його до user stories. Формат, помилки й одиниці спільні для SQL, web та exporter.

**Вихід**: перевірки коми/крапки, нуля/null, меж суми, високосного року та великих підсумків. FR-002–FR-006, FR-023.

### 2. Дані, історія та безпечний перехід

Forward migration атомарно знімає старі money fields, створює початкові розміщення та вимикає недатовані write/clear RPC. Додати значення показників із версіями, журнал, idempotency receipts, індекси та RLS. Legacy review підтверджує кожен старий показник лише один раз, без вигаданого факту оплати.

**Вихід**: відтворювана міграція на локальній копії fixtures, тест старого клієнта, ізоляція просторів, збереження old balance/topup, rollback notes. FR-007, FR-012–FR-015, FR-030.

### 3. RPC внесення та перенесення

Окреме поле — окрема версія. Запис, CAS, журнал і receipt — одна транзакція. Перенесення закриває старе розміщення та створює нове, оновлюючи той самий agent row. Блокувати зміни історії через видалення, старі RPC або обхідні шляхи. Одиночний clear/Undo всіх трьох показників реалізується в US1; US5 розширює той самий механізм batch-clear залишків/поповнень. Undo приймає request одиночного або масового очищення і перевіряє отримані версії.

**Вихід**: конкурентні записи одного/різних полів, повтор запиту, гонка запис/перенесення, колізія ID, каскад видалення простору. FR-008–FR-015, FR-027, FR-029.

### 4. Спільний календар і денне введення

Під'єднати фінансовий режим до Акаунтів, замінити недатовані поля та footer actions. Спільна панель дати, три поля, стани save/error/conflict, клавіатура, захист чернетки, історичний перегляд і midnight rollover. Розширити наявного власника accounts realtime, а не створювати другий канал із тим самим призначенням.

**Вихід**: денний сценарій працює з клавіатури, у двох сесіях, після reconnect і після півночі. FR-001, FR-004–FR-005, FR-021–FR-027, FR-031.

### 5. Місячний огляд та Excel

Один snapshot RPC для повного місяця/дня; UI використовує цей самий формат. Окремі суми spend/topup, залишки тільки за датами. Розширити XLSX writer без зміни старого buildXlsx контракту; додати п'ять аркушів, merges, freeze panes, styles, повні текстові ID, порожні клітинки.

**Вихід**: кожна сума в UI та workbook походить з одного snapshot; відкриття в Excel, регресія product catalog writer, p95 measurements. FR-016–FR-020, FR-028.

### 6. Наскрізна перевірка та підготовка до передачі

Покрити шість user stories зі spec, незалежні SQL/UI/export перевірки, нові layout cases, усі локалі. Пройти npm run verify, відповідні builds і verify:release перед кандидатом на випуск. Жодні production migrations/deploys автоматично не виконувати.

**Вихід**: артефакти вимірювань, тести доступу й конкурентності, Excel fixture, verification-result.json і відома процедура безвтратного відкату.

## Risks and Mitigations

- Старі клієнти: fail-closed upgrade error замість недатованого запису; старі дані збережені окремо.
- Існуючі каскади: deferred financial references + окремі delete guards; реальна перевірка видалення простору обов'язкова.
- «Поповнено» змінює семантику старого «Додати»: явна нова назва, одноразовий legacy review, копіювання не підтверджує платіж.
- Багато переносів: звіт має одну колонку на пару account UUID + agent UUID, об'єднуючи її повторні placements; перевіряти ширину та ліміти Excel до формування.
- Точність великих сум: не рахувати гроші floating point; при неможливості точного числового експорту повернути явну помилку, без округлення.
- Часові пояси: не використовувати timestamp для дати витрати; дату створення початкового розміщення фіксувати один раз, див. data-model.
