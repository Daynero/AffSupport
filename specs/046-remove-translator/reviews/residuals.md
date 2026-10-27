# Завершальний аудит залишків — 046

Пошук shipping source, Edge, shared, scripts, packaging, актуальних docs,
README/notices, config і workflows виконано 2026-10-27. Окремо перевірено
останнє визначення кожного SQL writer у двох forward-only міграціях 046.
Applied migrations, historical specs/releases/coverage baseline і generated DB
schema навмисно зберігають історичну структуру; це не активні tool contracts.

Немає imports видалених translation modules, model URLs/downloaders, llama
bootstrap або прихованого English pass. Чинні locales/legal/help не містять
назв видаленої фічі. Packaging вилучає її exclusive notices; clean-agent-dist
прибирає лише repo-owned output перед build, без доступу до user model cache.

## Причини збереження

- Інертні guards відмовляють старим запитам FEATURE_RETIRED до виконання.
  Читачі пропускають legacy translation variants/warnings без підміни оригіналу.
- Приватний companion role потрібний move/share/copy/trash/restore наявних
  файлів. Нові переклади й grants заборонені authoritative stored-kind guards.
- Аналітика читає історичні помилки та припинені роботи; це не product labels.
- TranslationKey/Translator позначають локалізацію UI; alignment — також CSS,
  word timestamps та 256KiB upload blocks. Bilingual README означає uk/en help.
- Whisper credit-pattern відсікає decoder hallucinations, не виконує переклад.
- Три pivot-згадки у старому reliability evidence описують минулі вимірювання.
  Чинні tasks/progress/acceptance цього документа оновлені до original-only.

## Повний результат пошуку з класифікацією

325 збігів; поточні source locations після останніх правок.

### Збережений захист оригіналу від decoder credits

- `apps/agent/src/whisper/transcriber.ts:1158` — `/^(?:transcription|translation|captions?)\s+by\s+.{0,40}$/iu,`

### Локалізація, UI layout або перетворення типів

- `apps/web/src/HomePage.tsx:92` — `import { useI18n, type TranslationKey } from './i18n';`
- `apps/web/src/HomePage.tsx:120` — `const GROUP_LABEL: Record<WebToolGroup, TranslationKey> = {`
- `apps/web/src/HomePage.tsx:127` — `const STATUS_LABEL: Record<ConnectionState, TranslationKey> = {`
- `apps/web/src/HomePage.tsx:153` — `const TILE_NOTE: Record<Availability, TranslationKey | undefined> = {`
- `apps/web/src/HomePage.tsx:179` — `function roleKey(role: TeamContextSnapshot['role']): TranslationKey {`
- `apps/web/src/two-factor/QuickCode.tsx:23` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/two-factor/QuickCode.tsx:27` — `const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {`
- `apps/web/src/two-factor/TwoFactorPage.tsx:18` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/two-factor/TwoFactorPage.tsx:39` — `const SORT_LABELS: Record<SortOrder, TranslationKey> = {`
- `apps/web/src/two-factor/TwoFactorRow.tsx:26` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/two-factor/TwoFactorRow.tsx:32` — `const SEED_ERROR_KEYS: Record<TwoFactorSeedError, TranslationKey> = {`
- `apps/web/src/two-factor/TwoFactorRow.tsx:39` — `function apiErrorKey(code: TwoFactorErrorCode): TranslationKey {`
- `apps/web/src/two-factor/TwoFactorRow.tsx:228` — `const [error, setError] = useState<TranslationKey | null>(null);`
- `apps/web/src/pages/AccountPage.tsx:80` — `import { useI18n, type Language, type TranslationKey } from '../i18n';`
- `apps/web/src/pages/AccountPage.tsx:91` — `type Translator = ReturnType<typeof useI18n>['t'];`
- `apps/web/src/pages/AccountPage.tsx:130` — `function AccountHeading({ t }: { t: Translator }) {`
- `apps/web/src/pages/AccountPage.tsx:373` — `const ROLE_KEYS: Record<TeamContextSnapshot['role'], TranslationKey> = {`
- `apps/web/src/pages/AccountPage.tsx:451` — `const LOCAL_APP_CHIP: Record<LocalAppState, { color: UiColor; key: TranslationKey }> = {`
- `apps/web/src/pages/admin/TariffRequests.tsx:13` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/pages/admin/TariffRequests.tsx:22` — `const CHANNEL: Record<string, TranslationKey> = {`
- `scripts/verify-i18n.mjs:7` — `* Finds translation keys that nothing reads, and reads that nothing defines.`
- `scripts/verify-i18n.mjs:42` — `* Taken from the first dictionary only: the second is the translation of the`
- `apps/web/src/pages/admin/TariffsPanel.tsx:34` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/pages/admin/TariffsPanel.tsx:66` — `const STATE_BADGE: Record<AdminTariffState, { key: TranslationKey; color: UiColor }> = {`
- `apps/web/src/pages/admin/TariffsPanel.tsx:77` — `const FILTER_LABEL: Record<TariffFilter, TranslationKey> = {`
- `apps/web/src/pages/admin/TariffsPanel.tsx:442` — `t: (key: TranslationKey, values?: Record<string, string | number>) => string,`
- `apps/web/src/pages/admin/TariffHistoryDrawer.tsx:16` — `import { useI18n, type Language, type TranslationKey } from '../../i18n';`
- `apps/web/src/pages/admin/TariffHistoryDrawer.tsx:30` — `type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;`
- `apps/web/src/components/ui.tsx:102` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/components/ui.tsx:104` — `export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;`
- `apps/web/src/components/ui.tsx:380` — `const keys: Record<JobStatus, TranslationKey> = {`
- `apps/web/src/pages/AdminPage.tsx:29` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/pages/AdminPage.tsx:114` — `const metricLabels: Record<keyof AdminOverview, TranslationKey> = {`
- `apps/web/src/pages/AdminPage.tsx:387` — `label: t(\`range${value}\` as TranslationKey)`
- `apps/web/src/pages/AdminPage.tsx:988` — `function statusKey(status: string): TranslationKey {`
- `apps/web/src/components/MediaActionsPanel.tsx:7` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/components/MediaActionsPanel.tsx:10` — `const LABELS: Record<MediaActionStatus, TranslationKey> = {`
- `apps/web/src/components/ReconnectAction.tsx:5` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/components/ReconnectAction.tsx:26` — `const REASON_KEY: Record<LinkReason, TranslationKey> = {`
- `apps/web/src/landing-viewer/internal/phaseKey.ts:2` — `import type { TranslationKey } from '../../i18n';`
- `apps/web/src/landing-viewer/internal/phaseKey.ts:4` — `export function phaseKey(phase: LandingPreviewPhase): TranslationKey {`
- `apps/web/src/landing-viewer/internal/phaseKey.ts:5` — `const keys: Record<LandingPreviewPhase, TranslationKey> = {`
- `apps/web/src/components/LabeledSkeleton.tsx:1` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/components/LabeledSkeleton.tsx:16` — `label: TranslationKey;`
- `apps/web/src/components/ui/Overlay.tsx:607` — `/* React Aria spells a placement as a side and an alignment, with a`
- `apps/web/src/landing-viewer/GallerySettingsMenu.tsx:4` — `import { useI18n, type TranslationKey } from '../i18n';`
- `apps/web/src/landing-viewer/GallerySettingsMenu.tsx:7` — `const DEVICES: Array<{ value: LandingPreviewDevice; key: TranslationKey; icon: typeof Monitor }> = [`
- `apps/web/src/components/ImageEmbeddingSection.tsx:21` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/components/ImageEmbeddingSection.tsx:568` — `const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);`
- `apps/web/src/components/ImageEmbeddingSection.tsx:792` — `function imageErrorKey(error: unknown): TranslationKey {`
- `apps/web/src/components/ImageEmbeddingSection.tsx:794` — `const errors: Record<string, TranslationKey> = {`
- `apps/web/src/components/ui/types.ts:80` — `* translation is lossy on purpose and it does not matter, because the library's`
- `apps/web/src/styles/components.css:3342` — `one of these; they disagreed on direction, gap and alignment. The safe action`
- `apps/web/src/api/client.ts:872` — `if (input.toolId === 'translation') throw new Error('FEATURE_RETIRED');`
- `apps/web/src/i18n.ts:9` — `export type TranslationKey = keyof typeof en;`
- `apps/web/src/i18n.ts:11` — `export const translationKeys = Object.keys(en) as TranslationKey[];`
- `apps/web/src/i18n.ts:23` — `key: TranslationKey,`
- `apps/web/src/i18n.ts:52` — `export function fileCountKey(language: Language, count: number): TranslationKey {`
- `apps/web/src/i18n.ts:59` — `export function landingCountKey(language: Language, count: number): TranslationKey {`
- `apps/web/src/i18n.ts:66` — `export function catalogSelectedCountKey(language: Language, count: number): TranslationKey {`
- `apps/web/src/i18n.ts:73` — `export function catalogCountKey(language: Language, count: number): TranslationKey {`
- `apps/web/src/i18n.ts:79` — `export function selectedCountKey(language: Language, count: number): TranslationKey {`
- `apps/web/src/i18n.ts:139` — `() => (key: TranslationKey, values?: Record<string, string | number>) =>`
- `apps/web/src/styles/team-accounts.css:393` — `an indent would buy the grouping by breaking that alignment, which is the`
- `apps/web/src/styles/team-accounts.css:458` — `exactly rather than missing it by fifteen pixels — an almost-alignment`
- `apps/web/src/lib/tool-registry.ts:4` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/lib/tool-registry.ts:79` — `labelKey: TranslationKey;`
- `apps/web/src/lib/tool-registry.ts:86` — `captionKey: TranslationKey;`
- `apps/web/src/styles/team-tasks.css:176` — `cards fill the row whatever the alignment says. */`
- `apps/web/src/styles/team-tasks.css:1114` — `* On a phone, with the longer translation, the group itself is wider than the`
- `apps/web/src/styles/team-tasks.css:1124` — `* With the longer translation a single group is wider than the window — "За`
- `apps/web/src/landing/LandingJobCard.tsx:11` — `import type { Language, TranslationKey } from '../i18n';`
- `apps/web/src/landing/LandingJobCard.tsx:885` — `function landingStatusKey(status: LandingAsset['status']): TranslationKey {`
- `apps/web/src/landing/LandingJobCard.tsx:886` — `const map: Record<LandingAsset['status'], TranslationKey> = {`
- `apps/web/src/landing/LandingJobCard.tsx:918` — `const map: Record<string, TranslationKey> = {`
- `apps/web/src/App.tsx:26` — `import { fileCountKey, type TranslationKey, useI18n } from './i18n';`
- `apps/web/src/App.tsx:949` — `const keys: Record<ConnectionState, TranslationKey> = {`
- `apps/web/src/App.tsx:1195` — `] as TranslationKey[]`
- `apps/web/src/App.tsx:1292` — `const keys: Record<SelectionWarning['reason'], TranslationKey> = {`
- `apps/web/src/App.tsx:1317` — `const map: Record<string, TranslationKey> = {`
- `apps/web/src/App.tsx:1361` — `const byCode: Record<string, TranslationKey> = {`
- `apps/web/src/transcription/errors.ts:1` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/transcription/errors.ts:4` — `const ERROR_MESSAGES: Record<string, TranslationKey> = {`
- `apps/web/src/team/palette/shortcuts.ts:1` — `import type { TranslationKey } from '../../i18n';`
- `apps/web/src/team/palette/shortcuts.ts:27` — `labelKey: TranslationKey;`
- `apps/web/src/team/palette/ShortcutSheet.tsx:2` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/palette/ShortcutSheet.tsx:15` — `const SCOPE_LABEL: Record<Shortcut['scope'], TranslationKey> = {`
- `docs/NO_SERVER_MEDIA_PLAN.md:208` — `removed; cataloged as a material. Make it bilingual and exclude it from the`
- `apps/web/src/team/palette/WorkspacePalette.tsx:14` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/palette/WorkspacePalette.tsx:88` — `const KIND_HEADING: Record<PaletteKind, TranslationKey> = {`
- `apps/web/src/team/explorer/ContentGrid.tsx:13` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/explorer/ContentGrid.tsx:44` — `const RENDER_LABEL: Record<NonNullable<TeamMaterialRow['landingRender']>['state'], TranslationKey> =`
- `apps/web/src/team/explorer/ContentGrid.tsx:271` — `? (\`teamExplorerThumbnail_${row.previewReason}\` as TranslationKey)`
- `apps/web/src/team/explorer/ContentGrid.tsx:397` — `function companionLabel(row: TeamMaterialRow): TranslationKey {`
- `apps/web/src/team/workspace/RestitchSourcePool.tsx:22` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/workspace/RestitchSourcePool.tsx:32` — `const AVAILABILITY_KEYS: Record<RestitchSource['availability'], TranslationKey | null> = {`
- `apps/web/src/team/explorer/TagDot.tsx:20` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/explorer/TagDot.tsx:23` — `export const COLOR_LABEL: Record<TeamMaterialTagColor, TranslationKey> = {`
- `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx:19` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/explorer/WorkspaceOperationsProvider.tsx:159` — `const STAGE_LABEL: Record<LocalOperationStage, TranslationKey> = {`
- `apps/web/src/team/workspace/WorkspaceShell.tsx:11` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/workspace/WorkspaceShell.tsx:133` — `const CONTENT_TABS: { section: TeamSection; label: TranslationKey }[] = [`
- `apps/web/src/team/members/TeamAuditPanel.tsx:4` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/members/TeamAuditPanel.tsx:15` — `export const ACTION_LABEL: Readonly<Record<string, TranslationKey>> = {`
- `apps/web/src/team/members/TeamAuditPanel.tsx:59` — `const DETAIL_LABEL: Readonly<Record<string, TranslationKey>> = {`
- `apps/web/src/team/workspace/HistoryDialog.tsx:24` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/workspace/HistoryDialog.tsx:63` — `const WORK_LABEL: Record<string, TranslationKey> = {`
- `apps/web/src/team/catalog/useMaterialActions.ts:19` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog/useMaterialActions.ts:68` — `const SUCCESS_COPY: Partial<Record<TeamAnalyticsAction, TranslationKey>> = {`
- `apps/web/src/team/catalog/useMaterialActions.ts:114` — `(action: TeamAnalyticsAction, code: string | null, successKey?: TranslationKey | null) => {`
- `apps/web/src/team/catalog/useMaterialActions.ts:154` — `successKey?: TranslationKey | null`
- `apps/web/src/team/workspace/SpaceStatePanel.tsx:2` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/workspace/SpaceStatePanel.tsx:35` — `const copy: Record<Explained, { title: TranslationKey; body: TranslationKey }> = {`
- `apps/web/src/team/errors.ts:3` — `import type { TranslationKey } from '../i18n';`
- `apps/web/src/team/errors.ts:14` — `const COPY: Record<TeamErrorCode, TranslationKey> = {`
- `apps/web/src/team/errors.ts:108` — `const SYNC_COPY: Record<string, TranslationKey> = {`
- `apps/web/src/team/errors.ts:125` — `function syncErrorCopy(code: string): TranslationKey | undefined {`
- `apps/web/src/team/errors.ts:143` — `t: (key: TranslationKey) => string`
- `apps/web/src/team/errors.ts:161` — `export function teamErrorMessageFor(error: unknown, t: (key: TranslationKey) => string): string {`
- `apps/web/src/team/errors.ts:183` — `const LOCAL_RUN: Record<string, TranslationKey> = {`
- `apps/web/src/team/errors.ts:200` — `const UNAVAILABLE: Record<UnavailableReason, TranslationKey> = {`
- `apps/web/src/team/errors.ts:214` — `t: (key: TranslationKey) => string`
- `apps/web/src/team/labels/TaskLabelChip.tsx:18` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/labels/TaskLabelChip.tsx:20` — `const COLOR_NAME: Record<TeamTaskLabelColor, TranslationKey> = {`
- `apps/web/src/team/labels/TaskLabelChip.tsx:32` — `export function taskLabelColorNameKey(color: TeamTaskLabelColor): TranslationKey {`
- `apps/web/src/team/labels/TaskLabelsSection.tsx:29` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/labels/TaskLabelsSection.tsx:45` — `function nameErrorKey(error: unknown): TranslationKey | null {`
- `apps/web/src/team/members/MemberPermissionsDialog.tsx:23` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/members/MemberPermissionsDialog.tsx:26` — `export const PERMISSION_COPY: Record<TeamPermissionFlag, TranslationKey> = {`
- `apps/web/src/team/members/MemberPermissionsDialog.tsx:37` — `const PERMISSION_HINT: Record<TeamPermissionFlag, TranslationKey> = {`
- `apps/web/src/team/landings/LandingViewerControls.tsx:10` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/landings/LandingViewerControls.tsx:12` — `const DEVICE_LABELS: Record<LandingDevicePreset, TranslationKey> = {`
- `apps/web/src/team/catalog/MaterialResults.tsx:11` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog/MaterialResults.tsx:21` — `const MATCHED_IN_COPY: Partial<Record<CatalogMatchField, TranslationKey>> = {`
- `apps/web/src/team/catalog/MaterialResults.tsx:31` — `const FRESHNESS_COPY: Record<CatalogSearchResponse['catalogFreshness']['state'], TranslationKey> = {`
- `apps/web/src/team/explorer/rowKinds.ts:7` — `import type { TranslationKey } from '../../i18n';`
- `apps/web/src/team/explorer/rowKinds.ts:25` — `export const KIND_LABEL: Record<TeamMaterialRowKind, TranslationKey> = {`
- `apps/web/src/team/explorer/rowKinds.ts:38` — `export const CATEGORY_LABEL: Record<MaterialCategory, TranslationKey> = {`
- `apps/web/src/team/explorer/rowKinds.ts:48` — `export const KIND_REASON: Partial<Record<TeamMaterialRowKind, TranslationKey>> = {`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:3` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:21` — `const STATE_COPY: Record<FolderSyncState, TranslationKey> = {`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:32` — `const PHASE_COPY: Record<FolderSyncStatus['phase'], TranslationKey> = {`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:41` — `{ body: TranslationKey; action: TranslationKey }`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:49` — `const ERROR_COPY: Record<string, { body: TranslationKey; action: TranslationKey }> = {`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:126` — `body: 'teamSyncErrorUnknown' as TranslationKey,`
- `apps/web/src/team/explorer/SyncStatusPanel.tsx:127` — `action: 'teamSyncActionRetry' as TranslationKey`
- `apps/web/src/team/members/InvitationPanel.tsx:5` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/members/InvitationPanel.tsx:57` — `} as const satisfies Partial<Record<TeamBaseRole, TranslationKey>>;`
- `apps/web/src/team/members/InvitationPanel.tsx:62` — `} as const satisfies Partial<Record<TeamBaseRole, TranslationKey>>;`
- `apps/web/src/team/product-catalog/ProductCatalogProgress.tsx:1` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/product-catalog/ProductCatalogProgress.tsx:15` — `const stages: ReadonlyArray<StatusStage<TranslationKey>> = [`
- `apps/web/src/team/preview/PreviewUnavailable.tsx:4` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/preview/PreviewUnavailable.tsx:6` — `const REASON_COPY: Readonly<Record<TeamPreviewUnavailableReason, TranslationKey>> = {`
- `apps/web/src/team/preview/PreviewUnavailable.tsx:14` — `const LANDING_REASON_COPY: Readonly<Record<TeamPreviewUnavailableReason, TranslationKey>> = {`
- `apps/web/src/team/catalog/CatalogFilters.tsx:14` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog/CatalogFilters.tsx:18` — `const LABEL_KEYS: Record<Exclude<keyof CatalogSearchFilters, 'geo'>, TranslationKey> = {`
- `apps/web/src/team/catalog/CatalogFilters.tsx:28` — `const KIND_KEYS: Record<string, TranslationKey> = {`
- `apps/web/src/team/catalog/CatalogFilters.tsx:35` — `const UNFILLED_KEYS: Record<string, TranslationKey> = {`
- `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx:23` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/product-catalog/ProductCatalogSettingsSection.tsx:152` — `keys: { pool: TranslationKey; fallback: TranslationKey; missing: TranslationKey },`
- `apps/web/src/team/product-catalog/ProductCatalogMenuDialog.tsx:11` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/product-catalog/ProductCatalogMenuDialog.tsx:117` — `const copy = async (text: string, done: TranslationKey) => {`
- `apps/web/src/team/library/ProcessLibraryDialog.tsx:4` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/library/ProcessLibraryDialog.tsx:20` — `type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;`
- `apps/web/src/team/library/ProcessLibraryDialog.tsx:342` — `const KIND_NOUN: Record<string, TranslationKey> = {`
- `apps/web/src/team/library/ProcessLibraryDialog.tsx:354` — `type KindTile = { key: string; label: TranslationKey; count: number };`
- `apps/web/src/team/materials/MaterialDetail.tsx:5` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/materials/MaterialDetail.tsx:73` — `const rows: Array<[TranslationKey, ReactNode]> = [];`
- `apps/web/src/team/storage/StorageChip.tsx:20` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/storage/StorageChip.tsx:46` — `const ATTENTION_CHIP: Record<TeamStorageAttentionReason, TranslationKey> = {`
- `apps/web/src/team/storage/StorageChip.tsx:54` — `const ATTENTION_BODY: Record<TeamStorageAttentionReason, TranslationKey> = {`
- `apps/web/src/team/storage/StorageChip.tsx:62` — `const COVERAGE_COPY: Record<CatalogCoverageState, TranslationKey> = {`
- `apps/web/src/team/storage/StorageChip.tsx:69` — `const NEXT_ACTION_COPY: Record<Exclude<CatalogNextAction, 'none'>, TranslationKey> = {`
- `apps/web/src/team/storage/StorageChip.tsx:206` — `const run = async (action: () => Promise<unknown>, done: TranslationKey) => {`
- `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx:21` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx:84` — `| { kind: 'result'; heading: TranslationKey; catalog: ShownCatalog };`
- `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx:86` — `function errorKey(error: unknown): TranslationKey | null {`
- `apps/web/src/team/product-catalog/CreateProductCatalogDialog.tsx:358` — `const copy = async (text: string, done: TranslationKey = 'productCatalogLinkCopied') => {`
- `apps/web/src/team/accounts/MarkerFilter.tsx:22` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/accounts/MarkerFilter.tsx:28` — `export function markerNameKey(value: TeamAccountMarkerFilter): TranslationKey {`
- `apps/web/src/team/materials/actions.ts:27` — `import type { TranslationKey } from '../../i18n';`
- `apps/web/src/team/materials/actions.ts:209` — `labelKey: TranslationKey;`
- `apps/web/src/team/accounts/plural.ts:10` — `import type { Language, TranslationKey } from '../../i18n';`
- `apps/web/src/team/accounts/plural.ts:20` — `one: TranslationKey;`
- `apps/web/src/team/accounts/plural.ts:21` — `few: TranslationKey;`
- `apps/web/src/team/accounts/plural.ts:22` — `many: TranslationKey;`
- `apps/web/src/team/accounts/plural.ts:23` — `other: TranslationKey;`
- `apps/web/src/team/accounts/plural.ts:44` — `export function teamPluralKey(language: Language, count: number, forms: Forms): TranslationKey {`
- `apps/web/src/team/accounts/plural.ts:54` — `function forms(one: TranslationKey, few: TranslationKey, many: TranslationKey): Forms {`
- `apps/web/src/team/materials/MaterialActionMenu.tsx:4` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/materials/MaterialActionMenu.tsx:23` — `const GROUP_HEADINGS: Record<MaterialActionGroup, TranslationKey> = {`
- `apps/web/src/team/materials/MaterialActionMenu.tsx:33` — `function toEntry(entry: ResolvedAction, t: (key: TranslationKey) => string): MenuEntry {`
- `apps/web/src/team/materials/MaterialActionMenu.tsx:49` — `t: (key: TranslationKey) => string`
- `apps/web/src/team/accounts/AgentRow.tsx:61` — `import { useI18n, type Language, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/accounts/AgentRow.tsx:112` — `function markerLabelKey(marker: TeamAgentRunMarker | null): TranslationKey {`
- `apps/web/src/team/accounts/AgentRow.tsx:120` — `function agentErrorKey(error: unknown): TranslationKey {`
- `apps/web/src/team/accounts/AgentRow.tsx:133` — `t: (key: TranslationKey, values?: Record<string, string | number>) => string`
- `apps/web/src/team/accounts/AgentRow.tsx:539` — `const named = (key: TranslationKey) => \`${t(key)} ${tag}\`;`
- `apps/web/src/team/accounts/AgentRow.tsx:992` — `const [error, setError] = useState<TranslationKey | null>(null);`
- `apps/web/src/team/accounts/AgentRow.tsx:1106` — `const [error, setError] = useState<TranslationKey | null>(null);`
- `apps/web/src/team/accounts/AccountGroup.tsx:59` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/accounts/AccountGroup.tsx:116` — `function nameErrorKey(error: unknown): TranslationKey {`
- `apps/web/src/team/accounts/AccountGroup.tsx:832` — `const [error, setError] = useState<TranslationKey | null>(null);`
- `apps/web/src/team/accounts/AccountGroup.tsx:837` — `const [seedError, setSeedError] = useState<TranslationKey | null>(null);`
- `apps/web/src/team/tasks/TaskAttachmentTile.tsx:20` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/tasks/TaskAttachmentTile.tsx:86` — `TranslationKey`
- `apps/web/src/team/tasks/TaskAgentTags.tsx:31` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/tasks/TaskAgentTags.tsx:63` — `t: (key: TranslationKey, values?: Record<string, string | number>) => string`
- `apps/web/src/team/launches/SubBuilder.tsx:8` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/launches/SubBuilder.tsx:9` — `const labels: Record<LaunchSubVariable, TranslationKey> = {`
- `apps/web/src/team/launches/LaunchEditor.tsx:30` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/launches/LaunchEditor.tsx:147` — `label: TranslationKey,`
- `apps/web/src/team/launches/LaunchEditor.tsx:150` — `help?: TranslationKey`
- `apps/web/src/team/launches/LaunchEditor.tsx:202` — `label: TranslationKey,`
- `apps/web/src/team/launches/LaunchEditor.tsx:204` — `help?: TranslationKey,`
- `apps/web/src/team/launches/LaunchGenerationProgress.tsx:6` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/launches/LaunchGenerationProgress.tsx:107` — `const localLabels: Record<string, TranslationKey> = {`
- `apps/web/src/team/tariffs/UpdaterResumeNotice.tsx:7` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/tariffs/UpdaterResumeNotice.tsx:13` — `const REASON_TEXT: Record<RecoveryReason, TranslationKey> = {`
- `apps/web/src/team/catalog-updater/CatalogUpdateProgress.tsx:2` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog-updater/CatalogUpdateProgress.tsx:4` — `const STAGES: ReadonlyArray<{ stage: CatalogUpdateStage; key: TranslationKey }> = [`
- `apps/web/src/team/catalog-updater/CatalogUpdateProgress.tsx:18` — `} as const satisfies Record<string, TranslationKey>;`
- `apps/web/src/team/tariffs/SpaceShowcase.tsx:12` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/tariffs/SpaceShowcase.tsx:22` — `const FEATURES: ReadonlyArray<{ key: TranslationKey; icon: typeof FolderOpen }> = [`
- `apps/web/src/team/tariffs/SpaceShowcase.tsx:175` — `{t(\`${feature.key}Description\` as TranslationKey)}`
- `apps/web/src/team/tariffs/TariffBanner.tsx:9` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/tariffs/TariffBanner.tsx:60` — `function bannerCopy(banner: SpaceAccessBanner): { key: TranslationKey; dated: boolean } {`
- `apps/web/src/team/launches/progress.ts:2` — `import type { TranslationKey } from '../../i18n';`
- `apps/web/src/team/launches/progress.ts:5` — `export const launchStageLabels: Partial<Record<LaunchStage, TranslationKey>> = {`
- `apps/web/src/team/launches/progress.ts:56` — `t: (key: TranslationKey) => string`
- `apps/web/src/team/catalog-updater/CatalogProgressRow.tsx:3` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog-updater/CatalogProgressRow.tsx:18` — `label: TranslationKey;`
- `apps/web/src/team/catalog-updater/UpdaterIntervalPicker.tsx:7` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog-updater/UpdaterIntervalPicker.tsx:12` — `const PRESETS: ReadonlyArray<[UpdaterPreset, TranslationKey]> = [`
- `apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx:4` — `import { useI18n, type TranslationKey } from '../../i18n';`
- `apps/web/src/team/catalog-updater/CatalogStatusDetails.tsx:16` — `TranslationKey`

### Діагностика та перевірка cutover

- `scripts/analytics/types.ts:36` — `analytics_translation_retirement?: boolean;`
- `scripts/analytics/types.ts:191` — `translation_retirement?: import('./library-retirement.js').TranslationRetirementEvidence;`
- `scripts/analytics/types.ts:247` — `translation_retirement?: import('./library-retirement.js').TranslationRetirementEvidence;`
- `scripts/analytics/types.ts:273` — `translation_retirement?: import('./library-retirement.js').TranslationRetirementEvidence;`
- `scripts/analytics/types.ts:909` — `translation_retirement?: import('./library-retirement.js').TranslationRetirementEvidence;`
- `apps/web/src/analytics/errors.ts:110` — `TRANSLATION_FAILED: 'translate',`
- `apps/web/src/analytics/errors.ts:111` — `TRANSLATOR_UNAVAILABLE: 'translate'`
- `scripts/analytics/coverage-registry.ts:756` — `unobservable: ['translation request and result'],`
- `scripts/analytics/code-map.ts:65` — `const AGENT_TRANSLATION = SHARED_TYPES;`
- `scripts/analytics/code-map.ts:66` — `const AGENT_TRANSLATOR = SHARED_TYPES;`
- `scripts/analytics/code-map.ts:275` — `TRANSLATION_FAILED: {`
- `scripts/analytics/code-map.ts:277` — `agent: [AGENT_TRANSLATION],`
- `scripts/analytics/code-map.ts:280` — `TRANSLATOR_UNAVAILABLE: {`
- `scripts/analytics/code-map.ts:282` — `agent: [AGENT_TRANSLATOR, AGENT_TRANSLATION],`
- `scripts/generate-team-contract-sql.mjs:234` — `const retirementPath = resolve(root, 'supabase/migrations/20261207090000_retire_translation.sql');`
- `scripts/analytics/library-retirement.ts:4` — `export interface TranslationRetirementRow {`
- `scripts/analytics/library-retirement.ts:18` — `export interface TranslationRetirementEvidence {`
- `scripts/analytics/library-retirement.ts:20` — `rows: TranslationRetirementRow[];`
- `scripts/analytics/library-retirement.ts:39` — `export async function getTranslationRetirementEvidence(`
- `scripts/analytics/library-retirement.ts:45` — `): Promise<TranslationRetirementEvidence> {`
- `scripts/analytics/library-retirement.ts:46` — `const result: TranslationRetirementEvidence = {`
- `scripts/analytics/library-retirement.ts:47` — `supported: Boolean((await getSchema()).tables.analytics_translation_retirement),`
- `scripts/analytics/library-retirement.ts:54` — `result.blind_spots.push('Translation retirement projection unavailable; absence is unknown.');`
- `scripts/analytics/library-retirement.ts:77` — `from public.analytics_translation_retirement`
- `scripts/analytics/library-retirement.ts:138` — `} as TranslationRetirementRow);`
- `scripts/analytics/library-retirement.ts:144` — `export function inspectTranslationRetirement(`
- `scripts/analytics/library-retirement.ts:146` — `evidence: TranslationRetirementEvidence`
- `scripts/analytics/library-retirement.ts:169` — `translation_retirement: evidence,`
- `scripts/analytics/queries.ts:3` — `getTranslationRetirementEvidence,`
- `scripts/analytics/queries.ts:4` — `inspectTranslationRetirement`
- `scripts/analytics/queries.ts:1790` — `translation_retirement: await getTranslationRetirementEvidence(`
- `scripts/analytics/queries.ts:2168` — `const [core, retirement, translation, initialOriginal] = await Promise.all([`
- `scripts/analytics/queries.ts:2171` — `getTranslationRetirementEvidence(id, null, asOf ?? new Date().toISOString(), 'identity', limit),`
- `scripts/analytics/queries.ts:2211` — `return { ...receiptInspection, translation_retirement: translation };`
- `scripts/analytics/queries.ts:2215` — `inspectTranslationRetirement(id, translation) ?? {`
- `scripts/analytics/queries.ts:2217` — `translation_retirement: translation,`
- `scripts/analytics/queries.ts:2224` — `translation_retirement: translation,`
- `scripts/analytics/investigate.ts:1` — `import { getTranslationRetirementEvidence } from './library-retirement.js';`
- `scripts/analytics/investigate.ts:1712` — `const translation_retirement = await getTranslationRetirementEvidence(`
- `scripts/analytics/investigate.ts:1718` — `for (const detail of translation_retirement.blind_spots)`
- `scripts/analytics/investigate.ts:1720` — `for (const row of translation_retirement.rows.filter(`
- `scripts/analytics/investigate.ts:1881` — `translation_retirement,`
- `scripts/analytics/schema.ts:36` — `'analytics_translation_retirement'`
- `scripts/analytics/schema.ts:68` — `...(has('table', 'analytics_translation_retirement')`
- `scripts/analytics/schema.ts:69` — `? { analytics_translation_retirement: true }`
- `scripts/analytics/schema.ts:126` — `table !== 'analytics_translation_retirement' &&`
- `scripts/test-translation-retirement-upgrade.mjs:149` — `const boundary = migrationNames.indexOf('20261207090000_retire_translation.sql');`
- `scripts/test-translation-retirement-upgrade.mjs:153` — `sql(readFileSync('tests/fixtures/translation-retirement-upgrade.sql', 'utf8'));`
- `scripts/test-translation-retirement-upgrade.mjs:159` — `'tests/translation-retirement-upgrade-postgres.test.ts',`
- `scripts/test-translation-retirement-upgrade.mjs:166` — `SOTY_TRANSLATION_UPGRADE_CONTAINER: target,`
- `scripts/test-translation-retirement-upgrade.mjs:167` — `SOTY_TRANSLATION_UPGRADE_ORDER: order,`
- `scripts/test-translation-retirement-upgrade.mjs:178` — `if (process.env.SOTY_TRANSLATION_GENERATE_TYPES === '1') {`

### Інертні відмови, нормалізація та історичні коди

- `packages/shared/src/team/library-processing.ts:335` — `if (isRecord(raw) && raw.kind === 'translation') continue;`
- `packages/shared/src/types.ts:2125` — `'TRANSLATION_FAILED',`
- `packages/shared/src/types.ts:2126` — `'TRANSLATOR_UNAVAILABLE'`
- `apps/agent/src/team-bridge/library.ts:58` — `if ((request.kind as string) === 'translation')`
- `supabase/functions/drive-ops/index.ts:1022` — `if (operation.toolId === 'translation')`
- `supabase/functions/drive-ops/index.ts:1874` — `if (toolId === 'translation')`
- `supabase/functions/drive-ops/index.ts:2081` — `if (operation.toolId === 'translation')`
- `apps/agent/src/team-bridge/process.ts:175` — `if (request.toolId === 'translation') return Promise.reject(new Error('FEATURE_RETIRED'));`
- `apps/agent/src/team-bridge/routes.ts:143` — `if (record(request.body) && request.body.toolId === 'translation') return retiredCommand(reply);`
- `apps/agent/src/team-bridge/routes.ts:174` — `if (record(request.body) && request.body.kind === 'translation') return retiredCommand(reply);`
- `apps/agent/src/transcription/document-store.ts:417` — `if (w.code === 'PIVOT_UNAVAILABLE') continue;`
- `apps/agent/src/transcription/document-store.ts:506` — `.filter(w => String(w.code) !== 'PIVOT_UNAVAILABLE')`
- `apps/agent/src/transcription/routes.ts:52` — `if ('translationLanguage' in body || 'translationDeclined' in body) {`
- `apps/agent/src/transcription/routes.ts:162` — `app.post('/api/transcription/translator/download', async (_request, reply) => {`
- `apps/agent/src/transcription/routes.ts:167` — `app.post('/api/transcription/translator/cancel', async (_request, reply) => {`
- `apps/agent/src/transcription/routes.ts:301` — `app.post('/api/transcription/jobs/:id/save-with-translation', async (_request, reply) => {`
- `apps/agent/src/transcription/routes.ts:306` — `app.post('/api/transcription/jobs/:id/translations', async (_request, reply) => {`
- `apps/agent/src/transcription/routes.ts:311` — `app.get('/api/transcription/jobs/:id/translations/:language', async (_request, reply) => {`
- `apps/agent/src/transcription/routes.ts:316` — `app.delete('/api/transcription/jobs/:id/translations', async (_request, reply) => {`

### Приватне читання старих companion-файлів

- `supabase/functions/_shared/library.ts:33` — `role: 'source' | 'transcript' | 'translation';`
- `supabase/functions/_shared/library.ts:173` — `!['source', 'transcript', 'translation'].includes(String(value.role))`

### Таймінги оригіналу або вирівнювання блоків upload

- `apps/agent/src/team-bridge/transfer.ts:12` — `// Drive requires 256 KiB alignment, not one request per 256 KiB. Larger chunks`
- `apps/agent/src/transcription/document-store.ts:33` — `// occurrence of a common word and consume the rest of the alignment cursor.`
- `apps/agent/src/transcription/document-store.ts:34` — `const WORD_ALIGNMENT_LOOKAHEAD = 32;`
- `apps/agent/src/transcription/document-store.ts:110` — `* Treating candidates as alignment metadata instead means they can never add,`
- `apps/agent/src/transcription/document-store.ts:162` — `const sourceCount = Math.min(WORD_ALIGNMENT_LOOKAHEAD, sources.length - sourceCursor);`
- `apps/agent/src/transcription/document-store.ts:164` — `WORD_ALIGNMENT_LOOKAHEAD * 2,`
- `apps/agent/src/transcription/document-store.ts:225` — `// Refill before the horizon can bias the next phrase's alignment.`
- `apps/agent/src/transcription/document-store.ts:226` — `if (i >= WORD_ALIGNMENT_LOOKAHEAD / 2 || j >= WORD_ALIGNMENT_LOOKAHEAD) break;`
- `apps/agent/src/transcription/segmentation.ts:104` — `* alignment, which used to carry the same loop each.`
- `docs/TEAM_RESTITCH.md:47` — `The uploader previously treated Drive's 256 KiB alignment requirement as the chunk size.`
- `docs/TEAM_RESTITCH.md:56` — `alignment, a short final chunk, acknowledged progress, and cancellation without finalization.`
- `docs/TEAM_WORKSPACE_OPERATIONS.md:183` — `| Resumable upload      | 256 KiB alignment; session URI remains memory-only                                                         |`

### Історичні вимірювання, не чинна можливість

- `docs/TRANSCRIPTION_RELIABILITY_PLAN.md:20` — `фрази в середині й кінці та англійський pivot. Після виправлення прив'язки`
- `docs/TRANSCRIPTION_RELIABILITY_PLAN.md:38` — `англійського pivot; 155 с обробки. Еталон: 409 лексичних одиниць; результат:`
- `docs/TRANSCRIPTION_RELIABILITY_PLAN.md:267` — `- \`IN_1\`: фінальний source/pivot і всі контрольні середні/кінцеві фрази`

## Пізніше уточнена native HTTP межа

`apps/agent/src/team-bridge/routes.ts` перевіряє лише точні legacy literals
`body.toolId === 'translation'` та `body.kind === 'translation'` після глобальної
авторизації. `retiredCommand` записує closed refusal і повертає409 FEATURE_RETIRED,
без delegate/process/grant calls. Це додатковий інертний guard, не виконуваний tool.
`safeErrorCode`/`routeFailure` зберігають upstream FEATURE_RETIRED/409.
Перевірено real Fastify route tests та facade test:32 focused PASS загалом.
