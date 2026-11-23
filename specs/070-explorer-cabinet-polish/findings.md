# 070 · Знахідки

## T003 · 34 ширини → п'ять

Мапа R4: ≤ 520 → 480; 521–659 → 640; 660–840 → 768; 841–1060 → 1024; понад 1060 → 1280. Вузьке правило лишається `max-width: N`; широке правило, що йому відповідає (`min-width: N+1` чи `min-width: N`), стає `(width > N)` того самого кроку — так на рівно N px не діють обидва (iPad вертикально — рівно 768). Порожні блоки `@media` видалено, а не перенесено.

Знімки до/після на сусідніх ширинах тут не робились: у робочій копії немає ні піднятої бети, ні агента, а запуск браузера на цій машині — окремий важкий процес. Нижче для кожного правила записано стару й нову ширину та екрани, яких воно торкається; візуальний прохід на двох сусідніх ширинах кожного кроку (наприклад 560 і 640, 720 і 768, 1000 і 1024, 1100 і 1280) робиться в beta-раунді, разом із T069. Найбільші зсуви, які варто дивитись першими: 1100–1200 → 1280 (компресор, транскрипція, менеджер каталогів, учасники), 560 → 640 (провідник, шапка простору, акаунти), 820 → 768 (переглядач лендингів, разом з `NARROW_QUERY` у `useLandingViewer.ts`).

Перевірка в режимі звіту: `node scripts/check-design-tokens.mjs` (ворота вмикає T065).

### `styles.css`

| Рядок (до) | Було                                    | Стало                                | Правила                                                                                                                               | Екрани                               |
| ---------- | --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 358        | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.topbar`, `.topbar-lead`, `.topbar-actions`                                                                                          | шапка                                |
| 520        | `(max-width: 1100px)`                   | `(max-width: 1280px)`                | `.support-trigger .support-trigger-label`                                                                                             | шапка                                |
| 526        | `(max-width: 960px)`                    | `(max-width: 1024px)`                | `.support-trigger`                                                                                                                    | шапка                                |
| 2830       | `(max-width: 520px)`                    | `(max-width: 480px)`                 | `.release-update-notice`, `.release-update-actions`                                                                                   | оновлення                            |
| 3068       | `(max-width: 1040px)`                   | `(max-width: 1024px)`                | `.custom-settings`                                                                                                                    | компресор                            |
| 3074       | `(max-width: 760px)`                    | `(max-width: 768px)`                 | `:root`, `.topbar-lead .brand-link .soty-wordmark-img`, `.topbar-actions`                                                             | глобально, шапка                     |
| 3214       | `(max-width: 500px)`                    | `(max-width: 480px)`                 | `:root`, `.topbar-lead`, `.support-trigger`                                                                                           | глобально, шапка                     |
| 3303       | `(max-width: 420px)`                    | `(max-width: 480px)`                 | `.topbar-lead .brand-link .soty-wordmark`                                                                                             | шапка                                |
| 4939       | `(max-width: 520px)`                    | `(max-width: 480px)`                 | `.legal-content h1`                                                                                                                   | юридичні сторінки                    |
| 5000       | `(max-width: 980px)`                    | `(max-width: 1024px)`                | `.metric-grid`, `.admin-filters`                                                                                                      | адмінка                              |
| 5010       | `(max-width: 760px)`                    | `(max-width: 768px)`                 | `.public-home-content`, `.public-feature-grid article`, `.login-card`                                                                 | вхід / публічна, шапка               |
| 5061       | `(max-width: 500px)`                    | `(max-width: 480px)`                 | `.login-topbar`, `.public-home-content`, `.public-hero h1`                                                                            | шапка, вхід / публічна               |
| 5225       | `(max-width: 1100px)`                   | `(max-width: 1280px)`                | `.landing-settings-primary-row`                                                                                                       | лендинги                             |
| 6437       | `(max-width: 760px)`                    | `(max-width: 768px)`                 | `.landing-batch-header`, `.landing-batch-actions`, `.landing-batch-actions .button-primary`                                           | лендинги                             |
| 6494       | `(max-width: 500px)`                    | `(max-width: 480px)`                 | `.landing-batch-toggle`, `.landing-source-icon`, `.landing-source-icon svg`                                                           | лендинги                             |
| 7566       | `(max-width: 900px)`                    | `(max-width: 1024px)`                | `.transcript-split-body`, `.transcript-player-controls`                                                                               | транскрипція                         |
| 7575       | `(max-width: 1120px)`                   | `(max-width: 1280px)`                | `.transcript-modal-header`                                                                                                            | транскрипція                         |
| 7580       | `(max-width: 620px)`                    | `(max-width: 640px)`                 | `.transcript-modal-backdrop`, `.transcript-modal.transcript-split`, `.transcript-modal-header`                                        | транскрипція                         |
| 8184       | `(min-width: 561px)`                    | `(width > 640px)`                    | `.team-space-shell-header`, `.team-space-shell-header h1`, `.team-space-shell-header > .team-space-shell-identity`                    | шапка простору                       |
| 8279       | `(max-width: 639px)`                    | `(max-width: 640px)`                 | `.team-space-tabs-next`, `.team-space-tabs-next.is-hidden`                                                                            | шапка простору                       |
| 8736       | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-member-list li`, `.team-member-list li > div:first-child`, `.team-audit-list li > div:first-child > .team-audit-subject`       | учасники                             |
| 9259       | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.landing-full-view-toolbar`                                                                                                          | лендинги                             |
| 9445       | `(max-width: 1179px)`                   | `(max-width: 1280px)`                | `.team-invite-form`                                                                                                                   | учасники                             |
| 9451       | `(max-width: 860px)`                    | `(max-width: 1024px)`                | `.team-catalog-filters`, `.team-space-settings-header`                                                                                | каталоги, шапка простору             |
| 9461       | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-panel`, `.team-invitation-list li`, `.team-permission-grid`                                                                    | простір (картка), учасники           |
| 9640       | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-operation-overlay`                                                                                                             | простір (операції)                   |
| 9680       | `(max-width: 900px)`                    | видалено (порожній блок)             |                                                                                                                                       | —                                    |
| 9682       | `(max-width: 1120px)`                   | видалено (порожній блок)             |                                                                                                                                       | —                                    |
| 9684       | `(max-width: 620px)`                    | видалено (порожній блок)             |                                                                                                                                       | —                                    |
| 11166      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.task-date-filter`, `.task-status-filter`, `.task-status-filter-option`                                                              | задачі                               |
| 11625      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.creative-library-upload`, `.creative-library-upload-fields`, `.creative-library-heading-actions`                                    | бібліотека креативів                 |
| 11731      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.landing-viewer-controls`, `.landing-viewer-controls > *`                                                                            | лендинги                             |
| 11777      | `(max-width: 1200px)`                   | `(max-width: 1280px)`                | `.environment-badge`                                                                                                                  | шапка                                |
| 13382      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer`, `.team-explorer-tree`                                                                                               | провідник                            |
| 13416      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-explorer-folders-toggle`, `.team-explorer-location`, `.team-explorer-breadcrumb`                                               | провідник                            |
| 13953      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer-pane`                                                                                                                 | провідник                            |
| 14452      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer.has-pane`, `.team-explorer-pane`                                                                                      | провідник                            |
| 14489      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-explorer-toolbar-actions:has(> .team-explorer-list-controls)`, `.team-explorer-toolbar-actions > .team-explorer-list-controls` | провідник                            |
| 14846      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer-folders-toggle`, `.team-explorer-tree`, `.team-explorer.is-tree-open .team-explorer-tree`                             | провідник                            |
| 14857      | `(max-width: 719px)`                    | `(max-width: 768px)`                 | `.team-explorer-pane`, `.team-explorer-pane.is-empty`                                                                                 | провідник                            |
| 15295      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer > .team-explorer-toolbar`                                                                                             | провідник                            |
| 15416      | `(max-width: 400px)`                    | `(max-width: 480px)`                 | `.embedding-settings-row`, `.embedding-settings-row .field-label`, `.fit-mode-pictos`                                                 | компресор (картинки)                 |
| 15558      | `(max-width: 980px)`                    | `(max-width: 1024px)`                | `.settings-primary-row`                                                                                                               | компресор                            |
| 16336      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.job-progress-panel .job-progress-meta`, `.job-progress-panel .job-actions`                                                          | компресор                            |
| 16389      | `(max-width: 1180px)`                   | `(max-width: 1280px)`                | `.job-row`, `.job-row > .job-main`                                                                                                    | компресор                            |
| 17224      | `(max-width: 700px)`                    | `(max-width: 768px)`                 | `.tfa-countdown`, `.tfa-countdown-track`                                                                                              | 2FA                                  |
| 17677      | `(max-width: 860px)`                    | `(max-width: 1024px)`                | `.tfa-header`, `.tfa-search`, `.tfa-header-actions`                                                                                   | 2FA                                  |
| 17916      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-updater-profile`                                                                                                               | менеджер каталогів                   |
| 18005      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-updater-row`, `.team-updater-row > :first-child`, `.team-updater-row-main`                                                     | менеджер каталогів                   |
| 18147      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.team-updater-backdrop`, `.team-updater-dialog`, `.team-updater-header`                                                              | менеджер каталогів                   |
| 18173      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.team-updater-row`, `.team-updater-row-main`, `.team-updater-row-schedule`                                                           | менеджер каталогів                   |
| 18312      | `(max-width: 560px)`                    | `(max-width: 640px)`                 | `.team-space-shell-header`, `.team-space-shell-find kbd`, `.team-explorer-grid`                                                       | шапка простору, провідник, задачі    |
| 18408      | `(hover: hover) and (min-width: 561px)` | `(hover: hover) and (width > 640px)` | `.team-agent-row:not(.is-free):not(:hover):not(:focus-within) .team-agent-actions-stack .team-agent-run-add`                          | акаунти                              |
| 19387      | `(min-width: 561px)`                    | `(width > 640px)`                    | `.team-sync-panel-head`, `.team-sync-panel-head > *`, `.team-sync-panel-scope`                                                        | провідник (синхронізація)            |
| 19426      | `(max-width: 1023px)`                   | `(max-width: 1024px)`                | `.team-explorer > .team-explorer-header`, `.team-sync-panel-actions`                                                                  | провідник, провідник (синхронізація) |
| 19655      | `(max-width: 1099px)`                   | `(max-width: 1280px)`                | `.catalog-compact-table`, `.catalog-compact-table thead`, `.catalog-compact-table tr`                                                 | каталоги                             |
| 19707      | `(max-width: 720px)`                    | `(max-width: 768px)`                 | `.team-updater-dialog.catalog-manager-dialog`, `.catalog-compact-table tr`, `.catalog-compact-table td:nth-child(2)`                  | менеджер каталогів, каталоги         |
| 20350      | `(min-width: 1100px)`                   | `(width > 1280px)`                   | `.team-members-section > .team-space-settings-grid`                                                                                   | шапка простору                       |
| 20386      | `(max-width: 700px)`                    | `(max-width: 768px)`                 | `.team-member-list li`                                                                                                                | учасники                             |

Без змін (уже на сітці): 1159 `(max-width: 480px)`, 5231 `(max-width: 640px)`, 15870 `(max-width: 1280px)`.

### `styles/components.css`

| Рядок (до) | Було                 | Стало                 | Правила                                                                                                                                          | Екрани                   |
| ---------- | -------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 799        | `(max-width: 639px)` | `(max-width: 640px)`  | `.launch-result-warning`, `.launch-result-regenerate`, `.launch-result-section-heading`                                                          | запуски                  |
| 1228       | `(max-width: 639px)` | `(max-width: 640px)`  | `.launch-editor-source-grid`, `.launch-editor-section-heading`, `.launch-editor-section-heading > button`                                        | запуски                  |
| 4258       | `(max-width: 900px)` | `(max-width: 1024px)` | `.finance-daily-table .finance-daily-columns`, `.finance-daily-table .team-agent-row.finance-daily-row`, `.finance-daily-table .team-agent-id`   | акаунти (гроші), акаунти |
| 4857       | `(max-width: 560px)` | `(max-width: 640px)`  | `.launch-editor-budget-row`, `.launch-editor-budget-row > .ui-segmented`, `.launch-editor-budget-row > .field:has(.launch-editor-budget-values)` | запуски                  |

Без змін (уже на сітці): 5053 `(max-width: 640px)`.

### `styles/account.css`

| Рядок (до) | Було | Стало | Правила | Екрани |
| ---------- | ---- | ----- | ------- | ------ |

Без змін (уже на сітці): 259 `(max-width: 480px)`.

### `styles/team-tasks.css`

| Рядок (до) | Було                 | Стало                | Правила                                      | Екрани |
| ---------- | -------------------- | -------------------- | -------------------------------------------- | ------ |
| 20         | `(max-width: 720px)` | `(max-width: 768px)` | `.team-task-grid`                            | задачі |
| 259        | `(max-width: 720px)` | `(max-width: 768px)` | `.task-date-filter-calendar`                 | задачі |
| 1131       | `(max-width: 520px)` | `(max-width: 480px)` | `.task-date-filter`, `.task-date-filter > *` | задачі |

### `styles/shell.css`

| Рядок (до) | Було                  | Стало                 | Правила                                                             | Екрани |
| ---------- | --------------------- | --------------------- | ------------------------------------------------------------------- | ------ |
| 29         | `(max-width: 560px)`  | `(max-width: 640px)`  | `.topbar .connection-badge`, `.topbar .connection-badge-text`       | шапка  |
| 80         | `(max-width: 1000px)` | `(max-width: 1024px)` | `.user-menu-trigger .ui-button-label`, `.topbar .user-menu-trigger` | шапка  |

### `styles/launch-settings.css`

| Рядок (до) | Було                 | Стало                | Правила                                             | Екрани  |
| ---------- | -------------------- | -------------------- | --------------------------------------------------- | ------- |
| 47         | `(min-width: 640px)` | `(width > 640px)`    | `.launch-editor-compact .launch-editor-source-grid` | запуски |
| 53         | `(max-width: 639px)` | `(max-width: 640px)` | `.launch-editor-compact .launch-editor-refresh`     | запуски |

### `styles/transcription.css`

| Рядок (до) | Було                  | Стало                 | Правила                                                                                                           | Екрани       |
| ---------- | --------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------ |
| 40         | `(max-width: 760px)`  | `(max-width: 768px)`  | `.transcription-settings-grid`                                                                                    | транскрипція |
| 504        | `(max-width: 1180px)` | `(max-width: 1280px)` | `.transcription-row-quiet-actions .action-label`, `.transcription-row-quiet-actions .soty-button`                 | транскрипція |
| 516        | `(max-width: 900px)`  | `(max-width: 1024px)` | `.job-row.transcription-row`, `.transcription-row .job-row-header`, `.transcription-row .transcription-row-title` | транскрипція |
| 698        | `(max-width: 900px)`  | `(max-width: 1024px)` | `.transcript-player-volume`, `.transcript-player-volume input`, `.transcript-player-controls`                     | транскрипція |
| 755        | `(max-width: 900px)`  | `(max-width: 1024px)` | `.transcription-row-actions .transcription-export-popover`                                                        | транскрипція |

### `styles/team-accounts.css`

| Рядок (до) | Було                                    | Стало                                   | Правила                                                                                                                                                                                                            | Екрани  |
| ---------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1537       | `(max-width: 1200px)`                   | `(max-width: 1280px)`                   | `.team-account-space`                                                                                                                                                                                              | акаунти |
| 1552       | `(max-width: 720px)`                    | `(max-width: 768px)`                    | `.team-agent-run`, `.team-agent-run-text`, `.team-account-meta > span:not(.team-account-meta-free`                                                                                                                 | акаунти |
| 1607       | `(max-width: 1000px)`                   | `(max-width: 1024px)`                   | `.team-accounts-columns`, `.team-account-head:not(.is-editing)`, `.team-agent-row`                                                                                                                                 | акаунти |
| 1686       | `(max-width: 560px)`                    | `(max-width: 640px)`                    | `.team-accounts-occupancy-label`, `.team-accounts-occupancy`, `.team-accounts-occupancy-option`                                                                                                                    | акаунти |
| 2244       | `(max-width: 720px)`                    | `(max-width: 768px)`                    | `.team-account-meta > .team-account-tasks-link`                                                                                                                                                                    | акаунти |
| 2502       | `(hover: hover) and (max-width: 560px)` | `(hover: hover) and (max-width: 640px)` | `.team-agent-actions-stack`                                                                                                                                                                                        | акаунти |
| 2595       | `(min-width: 1001px)`                   | `(width > 1024px)`                      | `.team-account-space.is-unified .team-accounts-columns > .unified-finance-headings`, `.team-account-space.is-unified .team-accounts-columns > span:last-child`                                                     | акаунти |
| 2844       | `(max-width: 1000px)`                   | `(max-width: 1024px)`                   | `.team-account-space.is-unified .team-accounts-field`, `.team-account-space.is-unified .team-accounts-table`                                                                                                       | акаунти |
| 2979       | `(max-width: 1000px)`                   | `(max-width: 1024px)`                   | `.team-account-space.is-unified .team-agent-row`, `.team-account-space.is-unified .team-agent-row`, `.team-account-space.is-unified .team-agent-status`                                                            | акаунти |
| 3026       | `(max-width: 560px)`                    | `(max-width: 640px)`                    | `.team-account-space.is-unified .team-account-head:not(.is-editing)`, `.team-account-space.is-unified .team-account-head:not(.is-editing) .team-account-actions`, `.team-account-space.is-unified .team-agent-row` | акаунти |

Без змін (уже на сітці): 2751 `(max-width: 768px)`.

### `team/workspace/space-settings.css`

| Рядок (до) | Було                 | Стало                | Правила                                                                                                                                                                            | Екрани         |
| ---------- | -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 105        | `(max-width: 700px)` | `(max-width: 768px)` | `.team-space-settings .team-space-settings-grid .settings-section`, `.team-space-settings .settings-field-grid > .field-group`, `.team-space-settings .settings-field-grid select` | шапка простору |
| 134        | `(max-width: 700px)` | `(max-width: 768px)` | `.team-space-settings .team-task-labels-name`                                                                                                                                      | шапка простору |

### `team/product-catalog/catalog-image-import.css`

| Рядок (до) | Було                 | Стало             | Правила                                                                                                                          | Екрани   |
| ---------- | -------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 179        | `(min-width: 600px)` | `(width > 640px)` | `.catalog-image-library-info`, `.catalog-image-library-info > *`, `.catalog-image-library-info > .catalog-image-library-actions` | каталоги |
