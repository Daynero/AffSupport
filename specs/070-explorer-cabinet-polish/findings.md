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

### `team/product-catalog/catalog-settings-layout.css`

| Рядок (до) | Було                 | Стало                | Правила                                                                                                                    | Екрани   |
| ---------- | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| 60         | `(max-width: 700px)` | `(max-width: 768px)` | `.catalog-settings-editor .ui-accordion-aside`, `.catalog-settings-editor .ui-accordion-chevron`, `.catalog-price-actions` | каталоги |

### `styles/home.css`

| Рядок (до) | Було                  | Стало                | Правила                                                                 | Екрани  |
| ---------- | --------------------- | -------------------- | ----------------------------------------------------------------------- | ------- |
| 174        | `(min-width: 720px)`  | `(width > 768px)`    | `.home-tools`                                                           | домашня |
| 181        | `(min-width: 1100px)` | `(width > 1280px)`   | `.home-tools`                                                           | домашня |
| 475        | `(max-width: 760px)`  | `(max-width: 768px)` | `.home-panel .blocking-message .ui-alert-action`                        | домашня |
| 481        | `(max-width: 500px)`  | `(max-width: 480px)` | `.home-panel .blocking-message .ui-alert-action`, `.home`, `.home-tile` | домашня |

### `styles/landing-viewer.css`

| Рядок (до) | Було                 | Стало                | Правила                                                | Екрани               |
| ---------- | -------------------- | -------------------- | ------------------------------------------------------ | -------------------- |
| 1245       | `(max-width: 820px)` | `(max-width: 768px)` | `.lv-viewer`, `.lv-toolbar`, `.lv-group.is-navigation` | переглядач лендингів |
| 1307       | `(max-width: 560px)` | `(max-width: 640px)` | `.lv-canvas`, `.lv-source`                             | переглядач лендингів |

## T004 · Правила провідника → `styles/explorer.css`

Перенесено 258 правил: кожне, у якого **всі** селектори списку містять `.team-explorer`, з тими самими селекторами й оголошеннями, у тому самому порядку, усередині тих самих `@media` / `@container`; коментар, що стояв одразу перед правилом, переїхав разом із ним. Чотири правила зі змішаними списками (`.team-explorer-…` поруч із чужими селекторами — рядки ~11 780, 13 221, 13 802, 13 823 до зміни) лишились у `styles.css`: розрізати список означало б змінити селектори. Їх розбирає T066 разом із рештою прибирання.

`styles/index.css` підключає `explorer.css` одразу після `styles.css`. Звірка «множина правил до = множина правил після, порядок у кожному файлі збережено» — 3 060 = 3 060, 0 розбіжностей.

**Чому порядок не змінює каскаду.** Перенос міняє місцями лише пари «перенесене правило M, яке стояло раніше» — «правило R, що лишилось у `styles.css` і стояло пізніше»: раніше R вигравав нічию, тепер M. Нічия можлива, лише коли (1) M і R задають ту саму властивість чи її скорочення з тим самим `!important`, (2) мають однакову специфічність, (3) можуть влучити в один елемент. Перебір усіх пар (postcss + `@bramus/specificity` + `css-tree`) дав 26 084 кандидати за (1)+(2). Для (3) відкинуто пари, де R вимагає предка з екрана, у якому провідника немає (компресор, 2FA, адмінка, задачі, акаунти, учасники, менеджер каталогів — діалоги рендеряться в портал), і пари, де предмет селектора — класи, що ніколи не стоять разом на одному елементі (за всіма виразами `className` у `apps/web/src`, з урахуванням класів, складених шаблоном, і класів інвентаря `ui-*`, які можуть прийти на будь-який елемент). Решту 160 переглянуто вручну: усе це різні елементи (`.team-explorer-selection-actions > *` проти `.team-sync-panel-head`, `.team-explorer-rows .ui-table-row` проти `.team-process-panel.is-collapsed` тощо).

**Одна справжня нічия:** `<span className="team-explorer-tile-badge-layer creative-rank-tile-layer">` (`ContentGrid.tsx` 386). `.creative-rank-tile-layer` стояв після `.team-explorer-tile-badge-layer` і перебивав `align-items` і `padding` — емблема рангу тримає верхній лівий кут. Тому два правила `.creative-rank-tile-layer` (звичайне й у `@media (hover: none)`) переїхали в `explorer.css` разом із ним, у тому самому порядку; повторний перебір — нічиїх немає.

Тест `tests/material-detail-glyph.test.ts` читав правила плитки зі `styles.css`; тепер читає `styles.css` + `explorer.css`, очікування ті самі.

## T005 · Рамка простору → `styles/space-shell.css`

Перенесено 82 правила рамки простору: сторінка (`.team-space-page`), шапка з утилітами й перемикачем (`.team-space-shell*`, `.team-space-switcher*`), вкладки (`.team-space-tabs*`, `.team-space-tab`), лобі й картки (`.team-space-lobby*`, `.team-space-card-*`), «немає доступу» (`.team-space-no-access*`) — тим самим способом, що й у T004. Файл підключено одразу після `explorer.css`. Звірка `styles.orig` = `styles.css` + `explorer.css` + `space-shell.css`: 3 060 = 3 060 правил, порядок у кожному файлі збережено.

Не перенесено, свідомо:

- `.team-space-settings*` і `.team-space-name-form` — це діалог налаштувань і розділ учасників, а не шапка; вони йдуть з T051/T052 (для них уже є `team/workspace/space-settings.css`). Спека (FR-042) називала файл `styles/shell.css`, але той уже зайнятий шапкою інструментів (024, US27), тому ім'я — з плану.
- Сім правил зі змішаними списками (рядки ~280, 289, 5 151, 7 990, 8 663, 9 488 до зміни) — розрізати список означало б змінити селектори.
- `.team-space-card` — **єдина справжня нічия** перебору: відкривна картка простору — `<Card as="article" role="button">` (`team/lobby/SpaceCard.tsx`), а спільне правило `button, [role='button'], … { min-height: 44.2px }` стояло пізніше з тією самою специфічністю й вигравало в `min-height: 96px` картки. Після переносу виграла б картка, тож це одне правило лишилось на місці. Відзначено для T030: картці, мабуть, і треба 96 px, але це рішення візуальне, а не переносу.

Перебір для T005 ішов по оригінальному порядку (до T004) з трьома групами — `styles.css`, `explorer.css`, `space-shell.css`, — тож перевірено й пари «рамка простору ↔ провідник». Класи інвентаря (`ui-chip`, `ui-tab` …) тут уже не вважались «будь-якими»: такий клас ділить елемент лише з класами, переданими в `className` відповідного компонента (`<Chip className=…>`). Із 44 737 кандидатів після відсіву лишилось 254, переглянуто вручну; окрім картки — різні елементи або однакові значення (`align-content: start` в обох правилах `.team-space-shell-body :is(.team-panel, .team-space-settings)` і `.team-space-settings .team-panel`).

Тест `tests/shell-and-modal-layout.test.ts` читає тепер і `explorer.css`, і `space-shell.css`; очікування ті самі.
