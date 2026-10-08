# Contract: статус синхронізації у вебі

## `apps/web/src/team/syncStatus.ts` (реліз B; web-локальний, `packages/shared` не змінюється — принцип II)

```ts
export const FOLDER_SYNC_STATES = [
  'queued', 'running', 'retry_wait', 'blocked', 'canceling', 'canceled', 'succeeded', 'failed'
] as const;
export type FolderSyncState = (typeof FOLDER_SYNC_STATES)[number];
export const FOLDER_SYNC_PHASES = ['listing', 'reconciling', 'replaying_changes', 'done'] as const;
export const FOLDER_SYNC_BLOCKED_REASONS = ['canonical_failed', 'canonical_retrying', 'needs_reauth'] as const;

export interface FolderSyncStatus {
  jobId: string;
  requestId: string | null;
  scopeFolderId: string;            // '__root__' для всього простору
  state: FolderSyncState;
  phase: (typeof FOLDER_SYNC_PHASES)[number];
  blockedReason: (typeof FOLDER_SYNC_BLOCKED_REASONS)[number] | null;
  errorCode: string | null;         // closed set з sync-lifecycle-sql.md
  errorDetail: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  scanCompletedAt: string | null;
  completedAt: string | null;
  filesListed: number; filesAdded: number; filesUpdated: number; filesRemoved: number;
  itemsUnavailable: number; foldersDone: number; pendingFolders: number | null;
  coverage: 'complete' | 'partial' | 'permission_limited' | 'unknown';
  progressRevision: number;
  cancelable: boolean;
  sharedWith: number;
}
export function parseFolderSyncStatus(value: unknown): FolderSyncStatus | null; // відкидає невідомі state/phase
```

Реліз A не додає типів: хук читає чинний `FolderSyncStatus` із shared через `getFolderSyncStatus` (root включно після M1) і використовує `lastProgressAt` для stall-детектора; нові outcomes існують лише локально. 3-value `getFolderResyncStatus` лишається для старого web.

## `apps/web/src/api/team.ts`

| Функція | Реліз | Зміна |
| ------- | ----- | ----- |
| `resyncFolder(teamId, folderId, options?: { signal?: AbortSignal; requestKey?: string })` | A (signal), B (requestKey) | `.abortSignal(signal)`; при `requestKey` викликає 3-arg overload і повертає `{ syncJobId, requestId, outcome }` |
| `resyncDrive(teamId, options?)` | A/B | аналогічно |
| `getFolderResyncStatus(teamId, jobId, options?: { signal })` | A | без зміни мапи значень |
| `getFolderSyncStatus(teamId, jobId, options?: { signal })` | A (signal), B (новий тип) | парсер `parseFolderSyncStatus` |
| `findFolderSyncRequest(teamId, folderId, options?)` | A | нова; `null`, якщо немає |
| `cancelFolderSync(teamId, requestId)` | B | нова; повертає `{ jobState, requestOutcome }` |
| `withFreshSession(fn, options?: { signal })` у `lib/supabase.ts` | A | прокидає signal у повтор; `AbortError` не трактується як auth-помилка |

Усі помилки — `TeamApiError` зі стабільним `code`; `AbortError` мапиться у `TeamApiError('ABORTED', retryable: true)`.

## Хук `useFolderResync` (реліз A)

```ts
type FolderResyncOutcome =
  | 'succeeded' | 'failed'
  | 'unreachable'     // accept не відповів за 15 с; pending key = 'unknown'
  | 'disconnected'    // status read впав/обірвався; сервер продовжує; pending key збережено
  | 'stalled';        // 10 хв без зміни стану/прогресу; pending key збережено
```

| Константа | Значення | Що обмежує |
| --------- | -------- | ---------- |
| `ACCEPT_TIMEOUT_MS` | 15 000 | `resyncFolder`/`resyncDrive`/`findFolderSyncRequest` |
| `STATUS_TIMEOUT_MS` | 15 000 | кожен status read |
| `FINAL_REFRESH_TIMEOUT_MS` | 30 000 | `onComplete` |
| `STALL_TIMEOUT_MS` | 600 000 | без зміни `lastProgressAt` детального статусу (root включно з M1) |
| `POLL_INTERVAL_MS` | 5 000 | між status reads (як зараз) |

Pending key: localStorage `soty:folder-resync:<team>:<scope>` (ділиться між вкладками; `TeamContext` чистить префікс при logout/зміні акаунта). `scopeFolderIds` завжди починається з `'__root__'`. Кнопка видима лише owner/admin — як і RPC.

Гарантії: `accepting` і `active` скидаються у `finally` завжди; будь-який мережевий виклик отримує `AbortSignal.any([monitor.signal, AbortSignal.timeout(...)])`; callback-и (`onComplete`, `onOutcome`, `onProgress`) викликаються лише коли `latest.current.teamId` і scope збігаються з контекстом job; при `pending = 'unknown'` клік спершу робить `findFolderSyncRequest`.

Реліз B додає `onProgress(status: FolderSyncStatus)` і повертає `status` для панелі; реліз C використовує `progressRevision` для debounced invalidation (не частіше 1 разу на 5 с).

## `ExplorerProvider.refreshStrict` (реліз A)

`read(true)`: якщо після `await` `sequence !== readSequence.current`, дочекатись `inflight.current` (проміс найновішого read) і повернути його результат як успіх; `FOLDER_TREE_REFRESH_FAILED` кидається лише коли найновіший read теж впав. Те саме для `useFolderPage.refreshWindow(true)`.

## UI (реліз A — лише тексти; реліз B — панель)

| Ключ i18n | Коли | Текст (uk) |
| --------- | ---- | ---------- |
| `teamFolderResyncUnreachable` | outcome `unreachable` | «Не вдалося зв'язатися із сервером. Спробуйте ще раз — якщо запит уже прийнято, ми його знайдемо.» |
| `teamFolderResyncDisconnected` | outcome `disconnected` | «Зв'язок зі статусом втрачено. Синхронізація на сервері триває; поверніться пізніше або натисніть ще раз.» |
| `teamFolderResyncStalled` | outcome `stalled` | «Синхронізація давно без поступу. Можна зачекати або повторити; деталі — у статусі.» |
| `teamFolderResyncBlocked.*` | `blocked` + reason (B) | reason-специфічна причина і дія |
| `teamFolderResyncSummary.*` | `succeeded` (B) | «Додано N, оновлено M», «Змін немає», «Частково: K елементів недоступні» |

Панель статусу (B): компоненти з `apps/web/src/components/ui/` (Chip, Button, Progress, Tooltip), токени з `tokens.css`; `aria-live="polite"` на зміну стану, не на кожен файл; кнопка «Зупинити» лише коли `cancelable`; при `sharedWith > 0` — підказка про спільну роботу; copy-кнопка для `jobId`/`requestId`.
