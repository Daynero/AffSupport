# Data model

Existing CatalogUpdateProfile retains catalogId, five change toggles, version, outcome/reconciliation metadata. CatalogRegistryRow retains schedule, nextRunAt, lastUpdatedAt and active stage. No migration.

Draft: baseline profile/version + interval, edited values, dirty/pending/conflict. External revisions never overwrite dirty input. Save with expected version; conflicts retain draft. Cancel dirty state requires explicit discard.

Selection: set of catalog IDs independent of filters. Bulk patch only includes explicitly chosen fields; results per catalog. Current result controls retries.

Defaults: five future-catalog flags, loaded only when settings opened; draft and explicit Save. Existing catalog profiles untouched.

Attempt: immutable history with terminal result and delivery evidence; latest relevant state determines recovery.
