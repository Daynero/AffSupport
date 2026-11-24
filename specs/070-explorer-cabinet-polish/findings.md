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

## T008 · Сирі контроли в `team/`

`tests/team-raw-controls.test.ts` у режимі звіту (`GATE = false`, ворота — T065): на базі після T007 — **146 сирих контролів у 60 файлах** (без коментарів і прози). Найбільше: `catalog-updater/CatalogUpdaterDialog.tsx` 9, `accounts/AgentRow.tsx` 7, `tasks/TaskDateFilter.tsx`, `tasks/TaskAttachmentPicker.tsx`, `library/BulkUploadDialog.tsx`, `explorer/Breadcrumb.tsx` по 6, `explorer/ExplorerShell.tsx` і `explorer/ContentGrid.tsx` по 5. Повний список друкує сам тест. Задачі 070 закривають лише частину з них (провідник, акаунти, учасники, налаштування, менеджер каталогів, діалоги); файли задач (`team/tasks/*`, 3x), запусків (`team/launches/*`), помічника й палітри в жодній задачі 070 не названі — до T065 їм потрібні власні задачі, інакше ворота не ввімкнуться.

## T012–T014 · Панель провідника в один рядок

**Як перевірено наживо.** Бети на цій машині немає, тож провідник відкрито в dev-збірці з даними з пам'яті (`VITE_MOCK_DATA=true VITE_LOCAL_DEV_AUTH=true`, `dev/mock-supabase.ts`) і пройдено Playwright-ом на 360/768/1024/1440. Mock був зламаний: `rpc()` повертав голий `Promise`, а шар API дописує до кожного читання `abortSignal()`, тож простір не відкривався взагалі («Цей простір недоступний»). Тепер `rpc()` повертає обіцянку з `abortSignal`/`setHeader`/`throwOnError` — dev-прохід знову можливий для будь-якої задачі.

Заміри після T014 (ширина панелі, крок, висота рядка, primary): 360 → 294 px, `tight`, 38 px, 1; 768 → 694 px, `compact`, 38 px, 1; 1024 → 950 px, `full`, 38 px, 1; 1440 → 1016 px, `full`, 38 px, 1. Горизонтальної прокрутки сторінки немає на жодній ширині.

**Рішення.**

- **Пошук до T021.** Поле в панелі відкриває наявний режим пошуку на Enter (з текстом), `/` ставить курсор у поле. Пошук «на кожну літеру» не зроблено свідомо: режим монтує `TeamCatalog` з власним полем, і друковане перескакувало б у друге поле. T021 прибирає друге поле.
- **«Завантажити ▾»:** файли — через `FileTrigger` (сирий `<input type="file">` прибрано); папка — через наявний `pickFolder` (`showDirectoryPicker` або агент), а не `acceptDirectory`: лише дескриптор папки дає групі завантаження відновитися, а `webkitdirectory` віддає плаский список без нього (тест «does not offer a lossy webkitdirectory fallback» це й стереже).
- **Фільтр типів і сортування** переїхали зі смуги дій у смугу над списком (US1: «у самому списку»), не липку — як фільтри-чипи в Drive.
- **«…»**: синхронізація, обробка й стиснення цієї папки, кошик. У корені, де папки немає, замість «Обробити цю папку…» — «Обробити весь простір…». Поки скан іде, пункт лишається, але недоступний і каже чому (правило «присутнє — пояснене»).
- **Згортання** рахується від ширини самої панелі, а не вікна: дерево й панель деталей забирають свою частку того самого вікна. Кроки — у пікселях для української (довша мова), з поправкою на «← До задачі» (128) і перемикач дерева (52). Що пішло з рядка — пункт «…» зі словом; іконки в рядку завжди з `aria-label`.
- **Висота рядка 38 px** у всіх контролів: перемикач вигляду інвентаря (`md`) мав 46 px (сегменти 38 + власна рамка) — у панелі він стиснутий так само, як у редакторі запусків; рамку поля пошуку теж вписано в 38. Варто вирішити в самому інвентарі (поза 070): `SegmentedControl md` вищий за `Button md`.
- **Теми.** Dev-збірка відкрилась у темній; світла — у beta-проході.

## T015–T020 · Список, дерево, перетягування, стани, перевірка розкладки

- **Сортування заголовками (T016)** не серверне: `list_team_folder_page` порядку не приймає (сортує за власним ключем курсора), а `sort` меню завжди був клієнтським порядком завантажених сторінок. Заголовки й меню ведуть один і той самий стан, тож на теці понад сторінку (100) порядок — у межах завантаженого, як і раніше через меню. Справжнє серверне сортування великої теки — окрема задача бекенду (зміна RPC), поза 070 (FR-044).
- **Дерево (T017):** «нижче 1024» прочитано як «до 1024 включно» — так само, як решта `@media (max-width: 1024px)` після T003; на рівно 1024 (iPad горизонтально) дерево в шухляді.
- **Перше читання папки, що впало (T019),** не показувало нічого: `useFolderPage` рахував помилку лише для папки, чиї рядки вже колись прийшли, тож скелет висів без кінця і без «Спробувати ще». Тепер помилка належить папці, для якої читання впало.
- **`LoadingState` замість `LabeledSkeleton`** (T019): підпис «Завантажуємо цю папку…» тепер лише для читача екрана. Свідомо — так велить патерн інвентаря; якщо власник хоче видимий підпис для довгих завантажень, це зміна самого `LoadingState`, не провідника.
- **Перевірка розкладки (T020)** `scripts/check-explorer-layout.mjs` (`npm run check:explorer-layout`) працює проти будь-якого локального сайту: бети (`--site=http://127.0.0.1:5175`) або dev-сервера з даними з пам'яті (команда в шапці скрипта). Прогнано на dev-сервері: 360/390/768/1024/1280/1440 — у корені, у папці зі світлою темою, з «← До задачі»: усюди один рядок 38 px, рівно одна primary, без прокрутки вбік, «…» зі словами. На бетіній базі (справжні дані, довгі назви) не проганялось — у beta-прохід.
- **Скрипт знайшов справжню ваду:** сегменти перемикача вигляду (іконки) мали назву лише в `title`. `SegmentedControl` тепер дає сегменту-іконці `aria-label` з `title`.
- **Копії crossfade (058)**: на ~300 мс після натискання в рядку лежить інертна копія (`[inert]`, `aria-hidden`) — скрипт її не рахує. Це наявна поведінка `lib/auto-crossfade.ts`, не дубль кнопок.
- **З «← До задачі» на 1440** шлях складається до «… / Креативи» (поле пошуку тримає свою ширину) — прийнятно, корінь в одному натиску; на 1024 у цьому разі поле вже стає лупою.

## T021–T024 · Один пошук

- **Чотири задачі — один коміт.** Поле, результати, їхнє виділення, панель деталей і панель виділення сходяться в тих самих файлах (`ExplorerShell`, `ExplorerResults`); проміжні коміти не збиралися б.
- **Де живуть слова.** У `useExplorerSearch`, а не в адресі: адреса пишеться після відповіді пошуку (`onSearched`, з паузою), і поле, що читає адресу, губило б літери, набрані поки відповідь ішла. Адреса перемагає, коли її змінив хтось інший («Показати в папці», ⌘K, посилання) — це відрізняється від власного відлуння поля за останніми словами, які поле повідомило.
- **Коли починається пошук.** Від двох літер (`MIN_SEARCH_LENGTH`, як і раніше: одна літера — це «всі файли області»). Порожнє поле (Esc або стерте) — назад у папку. `scope=space` в адресі без слів (старі посилання `/landings`, `/creatives`) і далі відкриває результати.
- **Вибір у результатах — власний,** не виділення папки: виділення папки зберігає рядки з `driveFileId`/`driveVersion`, яких у результату немає (T023 забороняє їх вигадувати). Граматика та сама (`selectionGestures.ts`). Позначене переживає новий запит і йде разом із пошуком. Кошик з результатів — той самий `trashRows` (тип звужено до `TrashableMaterial`), «перешите» — той самий `deliverRestitched` (без версії Drive — читає файл, а не підготовку під версію).
- **Панель деталей і смуга — через портал** у вузли, які малює оболонка: панель — у `.team-explorer-pane-host` (`display: contents`, та сама третя колонка), смуга — у `.team-explorer-list-controls` під повідомленнями (липка, виміряна). Оверлеї (метадані, текст, обробка, походження) лишились у `TeamCatalog`; результати отримують їх як `openers`.
- **Повернення до пошуку.** `WorkspaceShell` пише адресу через `replace`, тому браузерний «Назад» не повертає до результатів; замість нього — «← До результатів» у групі шляху (поряд із «← До задачі»), поки людина в папках.
- **Панель виділення (T024)** тепер у смузі над списком замість «Тип»/сортування, однієї висоти з ними (38 px): поява панелі нічого не зсуває і не ховає шлях, поле й «Завантажити». Дії — з реєстру з `host: 'selection'`: три на панелі (завдання, обробка, кошик), решта — в «…» (вибрати все, до завдання, стиснути, перешите). «з інших папок» → «з них N в інших папках» (у результатах — «поза цими результатами»).
- **Що перевірено на beta.** Каталог пошуку beta порожній (`catalogFreshness: not_started` — Drive просить перепідключення), тож відповідь `search_materials` у headless-браузері підмінено рядками справжньої папки `vid` (лише в цьому браузері). Пройдено на 1440 (темна) і 390 (світла): набір → результати на місці, ↓ → фокус у списку й панель, відмітки → панель виділення в смузі (висота смуги 38 px з/без виділення), «Показати в папці» → папка з виділеним файлом → «До результатів» → той самий запит. Горизонтальної прокрутки немає.
- **Лишилось:** фасети («Фільтри») — окремим рядком над результатами (`<details>` не вміщається в смугу фіксованої висоти); історія запитів під полем зникла разом із другим полем — вона є в ⌘K.

## T025 · Картка деталей з задачі й з оновлювача

- **Двері — пункт «Подробиці…» у «…»** вкладення й рядка оновлювача; картка відкривається поверх (вкладене вікно), задача чи менеджер каталогів лишаються відкритими. У 024 T057 `detail` свідомо виключили з `updater-row` («одні двері з діалогу, що володіє адресою»), але T089/T025 прямо просить картку звідти — виключення знято, а сама картка не пропонує відкрити себе ще раз.
- **Каталог у картці** — це Google-таблиця, тож вид «Google-документ», папка — з рядка (`folderName`), «змінено» — останнє оновлення. Блок `MaterialCatalogFacts` усередині менеджера показує й посилання «Відкрити менеджер каталогів» — зайве всередині самого менеджера, але нешкідливе; прибрати — разом із T056/T057.
- Перевірено на beta (менеджер каталогів, 1440, світла тема): картка «TR 7_v23_catalog», «Тип: Google-документ», «Папка: vid», факти каталогу, примітка, дії.

## Фаза 4 · Поліровка провідника (прохід по beta)

Знайдено в beta-проході фази 3 (простір «Креативи», папка `vid`) і виправлено окремими комітами `fix(070)`; кожне перевірено на beta на 1440/1024/768/390 у двох темах (`check-explorer-layout.mjs`, обидві теми — PASS, плюс знімки).

- **Шрифт.** Дерево, плитки й смуга над списком успадковували `body` (`--text-3xl`, ~21 px на 1440): «Soty Cache» і назва плитки були більші за панель інструментів. Тепер назви — `--text-label` (як рядки списку), лічильники й мета — `--text-caption`, у дереві цифри табличні. Назва папки в панелі (шлях) лишилась більшою. Власник казав «~13–14 px»: `--text-label` = 15 px — найближчий крок інвентаря; нового токена не додано (сходи `label/caption` уже в списку). Сам `body` на `--text-3xl` — глобальне рішення поза провідником.
- **Плитка без картинки.** Значок виду був `72cqmin` (камера на пів плитки), а в папки — темна смуга з маленьким значком. Тепер обидві — значок 40 px по центру на поверхні самої картки, відділений від підпису лінією; у картці деталей — більший (до 72 px), але не постер. Тест `material-detail-glyph` (розмір у `cqmin`) зелений.
- **Сітка.** `minmax(184px, 232px)` + `justify-content: start` лишали порожню колонку справа на 1024 і 1440. Тепер `minmax(184px, 1fr)` — плитки розтягуються на весь рядок (і змінюють розмір, коли відкривається панель, як у Drive). Свідомо відмовились від рішення 024 US28 (плитка не змінює розміру) — правило власника «нічого кривого» сильніше.
- **Назви в списку з одного x.** Розкривач супутників («› 19», «› 2») мав ширину за своїм числом; тепер у списку, де він є хоч в одному рядку, кожен рядок тримає слот однієї ширини (табличні цифри), порожній там, де супутників немає. Заміряно: усі назви з x = 499.
- **Колонка рангу.** Була без заголовка й з доріжкою `1fr` — дірка посеред рядка перед «Тип». Тепер «Ранг», сортується, малюється лише там, де є що показати; вільну ширину забирає назва. (Пункти 4 і 5 пішли одним комітом — обидва про сітку колонок того самого списку.)
- **`/` у полі пошуку** — клавіша в кінці поля (як ⌘K у «Перейти до…»), заповнювач — просто «Шукати файли» (у коміті T021).
- **Телефон: картка деталей.** На ≤ 768 «аркуш знизу» успадковував `top` липкої панелі й тягнувся від шапки до низу вікна, а липкий заголовок списку малювався поверх. Тепер — справжній аркуш знизу (60 dvh), над липкими шарами провідника, з кнопкою «Закрити» (лише там, де картка — аркуш).
- **360 px.** Сторінка прокручується вбік на 24 px; провідник сам у межах (права межа 344 px, жоден його елемент не виходить). Виходять `topbar-actions` (423 px — T077) і шапка простору з вкладками (384 px — T078).

## Фаза 5 · Тиха шапка (T027–T031) і верхня панель на телефоні (T077, T078)

Перевірено на beta (простір «Креативи», Drive просить перепідключення — справжній стан «увага») на 1440 / 1024 / 768 / 390 / 360 у світлій і темній темах: горизонтальної прокрутки сторінки немає на жодній ширині (`scrollWidth = innerWidth`, на 360 було 384), помилок у консолі немає. Справний стан (`Усе працює` і панель) знято тим самим скриптом з підміною відповідей `get_team_storage_health_v2` і `needs_reauth → connected` лише в цьому браузері.

- **`useSpaceHealth` (T027)** — похідний стан із п'яти джерел, нічого нового не читає. Окрім `ok | attention` повертає `busy` окремим списком: фонова робота — не проблема, але й не «усе тихо». Порядок уваги — сховище, Soty на комп'ютері, живі оновлення, оновлювач, журнал лише на сесію. Відлік 8 с для живих оновлень тепер один хук (`useRealtimeGrace`): шапка передає чипу вже відлічене, інакше чип, змонтований після рішення шапки, чекав би ще 8 с. `disconnected` у сховища тепер «увага» (раніше зелений чип «Сховище не підключено»).
- **`SpaceHealth` (T028).** Усе добре — одна кнопка «Усе працює» (на телефоні лише значок, слово в імені) з панеллю п'яти рядків: що робить кожне джерело словами і одна дія (Подробиці / Перепідключити / Спробувати ще / Відкрити). Увага — чип самого джерела (наявні компоненти, з їхніми словами й діями), не більше двох; решта — «ще N», що відкриває ту саму панель. Робота — один чип: власний, коли робота одна, «Фонова робота · N», коли їх кілька. Чип сховища змонтований завжди (`showChip`), бо його вікно — адреса `storage=1`, яку відкриває й рядок панелі.
- **Оновлювач каталогів «За розкладом»** був постійним чипом/посиланням у шапці. Розклад, що чекає наступного запуску, — це «усе добре», тож він став рядком панелі («Каталогів за розкладом: 2 · Наступне через …»), а двері до менеджера каталогів — пунктом меню «Простір». Чипом він стає, лише коли оновлює (робота) або коли потрібна увага.
- **«Перейти до…» і «Простір» (T029)** — `Button`/`IconButton` інвентаря замість сирих `<button>`. На ≤ 640 обидві — значки (рендериться інша кнопка, а не ховається CSS-ом, щоб не було двох кнопок з одним іменем). «Перейти до…» тепер з компасом, а не лупою: на телефоні вона стоїть одразу над пошуком файлів провідника, і дві однакові лупи рядком нижче читалися як одне й те саме. Шапку винесено в `SpaceHeader.tsx` (WorkspaceShell 1441 → 1342 рядки).
- **Перепідключення показувалось двічі (знахідка beta).** Залишено одне місце — **чип сховища в шапці**: він є на кожному розділі (не лише у Файлах), за ним — вікно з причиною, хто може виправити, і кнопкою. Плашку «Лише перегляд» над списком провідника прибрано; щоб наслідок не загубився, слова чипа несуть і наслідок, і причину: «Лише перегляд · Drive від'єднався» (для видаленої папки — «Лише перегляд · підключену папку видалено»). Перший варіант «…сховище треба перепідключити» обрізався на 360 — скорочено. Провідник, як і раніше, просто не показує дій запису.
- **Стани (T030).** Панель стану сховища — `EmptyState` з дверима (налаштування або `PermissionState` «попросіть власника»); екран, коли в людини забрали право перегляду, був червоним реченням без жодної кнопки — тепер це той самий екран «Цей простір недоступний» з «До моїх просторів»; «Простір у розробці» отримав «На головну»; помилка лобі — `ErrorState`. **Відхилення:** «Попросити доступ» не зроблено — для запиту доступу немає API, а FR-044 забороняє нові; текст екрана й далі каже, кого просити.
- **Аналітика (T031).** У чипах шапки власних подій не було; єдина подія, що «переїжджає», — `reconnect_clicked` з поверхнею `team_shell` (ReconnectAction агента). У панелі стану вона та сама; тест `space-health-header.test.tsx` перевіряє, що перепідключення з панелі рахується як `team_shell`. `operationAnalytics` (операції з файлами) шапки не стосується — без змін, його тест зелений.
- **Шапка ≤ 640 (T078).** Назва + значки в один рядок (назва обрізається «…»), чипи уваги — окремим рядком на всю ширину, у справному стані — один рядок. Вкладки прокручуються з затуханням з того боку, де є ще, стрілка «далі» — `IconButton`, відкрита вкладка завжди прокручена в поле зору (посилання на «Учасники» на телефоні відкривало розділ з вкладкою за краєм). Внутрішні відступи рамки на ≤ 640 — `--space-3`.
- **Верхня панель (T077).** На ≤ 640: замість словесного логотипа — знак (шестикутник; словесний на 390 мав ширину 0), чарунки — лише число, тема й мова — у меню акаунта (рядки «Світла тема» / «English», кожен каже, що зробить натискання). Плашка «БЕТА» тепер у панелі біля знака на всіх ширинах; плаваюча копія лишилась для екранів без панелі (вхід, правові) і ховається, щойно панель має свою. Чип зв'язку — крапка вже з ≤ 768 (на 768 слова обрізались до «Soty підключен», а «БЕТА» торкалась чарунок). **Відхилення:** блискавка (обмеження потужності) лишилась у панелі, а не в меню: її значок показує чинне обмеження (наприклад «60»), а сховане в меню обмеження читається як «Soty став повільним» — саме від цього застерігає компонент. На 360 усе вміщується: знак, БЕТА, чарунки, блискавка, крапка, аватар.
- **Пошук провідника на телефоні (запит координатора).** На `tight` лупа тепер лишається в рядку (відкриває поле поверх шляху), пункт «Шукати файли» з «…» прибрано; обрізається шлях. `check-explorer-layout.mjs` на beta: 360/390/768/1024/1440 — PASS.

**Для фаз 6–9.**

- Кнопки панелі мають дві висоти: блискавка й тема — 44 px (`--control-height-lg`, дотиковий мінімум), решта — 38. Вирішити разом із ShortcutSheet/темою на сторінці акаунта (US9).
- Домашня сторінка на 390: бджола-ілюстрація лягає на текст картки простору («Цей простір ще налаштовується») — поза шапкою, для US9.
- Тест сирих контролів: шапка простору більше не має сирих `<button>` (знайти, меню, «далі» вкладок).
- У рядку сховища в панелі статус повторює назву («Сховище — Сховище актуальне · щойно»), бо це той самий текст, що й у чипа; якщо прибирати — разом із копірайтом чипа.
