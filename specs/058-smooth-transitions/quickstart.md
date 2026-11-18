# Quickstart: перевірка 058

## Локальні гейти (по одному, `uptime` перед кожним)

```sh
npx prettier --check <змінені файли>
npx eslint <змінені файли>
npm run typecheck:projects        # або tsc -b apps/web
npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism \
  tests/navigation-motion.test.ts tests/motion-registry.test.ts \
  tests/overlay-presence.test.tsx tests/navigation-analytics.test.ts \
  tests/motion-smoke-metric.test.ts tests/analytics-guard-contract.test.ts \
  tests/analytics-coverage-registry.test.ts tests/analytics-cli.test.ts \
  tests/design-token-contract.test.ts tests/stylesheet-integrity.test.ts \
  tests/ui-consistency.test.tsx tests/design-components.test.tsx
node scripts/check-design-tokens.mjs && node scripts/check-tailwind-classes.mjs && node scripts/verify-styles.mjs
```

## Бета

```sh
colima status || colima start
npm run beta:up                     # з воркдерева AffSupport-058
# міграція guard — psql у supabase_db_wishly + рядок у supabase_migrations.schema_migrations
node scripts/motion-smoke.mjs --base http://127.0.0.1:5175 --out <scratchpad>/motion
```

Очікування: у звіті кожен перехід `excess ≤ 1.6`, `after_end_diff ≈ 0`,
`layout_shift < 0.05`; для холодного розділу видно заготовку, а не порожнечу.

## Ручний прохід (історії 1–5)

1. Простір: Файли → Завдання → Запуски → Акаунти → Учасники → Файли, швидко й повільно.
2. Інструменти → простір → «Назад» (прокрутка відновлена, логотип пливе, а не стрибає).
3. Діалог → вкладений діалог → закрити обидва.
4. Вихід → вхід → застосунок.
5. Те саме з «Зменшити рух» (DevTools → Rendering → prefers-reduced-motion).

## Аналітика

```sh
npm run analytics -- navigation --period 1d --json
```

Мають бути видні спроби `superseded`, зі `skeleton_ms > 0` і в режимі `instant_reduced`.
