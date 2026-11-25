# Contract: StorageAdapter (edge, `supabase/functions/_shared/storage/`)

Один інтерфейс для операцій з байтами матеріалу. Реалізації: `DriveAdapter` (обгортка над `GoogleDriveClient`, видаляється на етапі F) і `R2Adapter`. Вибір: `adapterFor(team)` за `teams.storage_backend`. Код поза `_shared/storage/` не імпортує `GoogleDriveClient` (перевірка в `npm run verify`, задача T006).

```ts
interface StorageAdapter {
  readonly backend: 'drive' | 'r2';

  /** URL читання для браузера чи агента. R2-медіа — постійний public_url (без підпису); R2-приватне — presigned GET; Drive — наявний /range. */
  readUrl(input: {
    material: MaterialRef;
    purpose: 'preview' | 'download' | 'agent_input' | 'thumbnail';
    downloadName?: string;          // -> response-content-disposition
  }): Promise<{ url: string; expiresAt: string; headers?: Record<string, string> }>;

  /** Почати запис. Резервує квоту (R2) або відкриває resumable-сесію (Drive). */
  startUpload(input: {
    teamId: string; actorId: string;
    declaredBytes: number; contentType: string; fileName: string;
    source: 'browser' | 'agent' | 'import';
    purpose: UploadPurpose;
  }): Promise<UploadSession>;

  /** URL однієї частини (R2) — поновлюється без перезапуску сесії. */
  partUrl(input: { sessionId: string; partNumber: number }): Promise<{ url: string; expiresAt: string }>;

  /** Перевірити й зробити видимим. Повертає матеріал (новий чи оновлений для overwrite). */
  finalizeUpload(input: {
    sessionId: string; actorId: string;
    parts: Array<{ partNumber: number; etag: string; sha256: string }>;
    sha256: string;
  }): Promise<FinalizedMaterial>;

  abortUpload(input: { sessionId: string; reason: string }): Promise<void>;

  /** Серверна копія байтів (`copy`). R2: CopyObject + новий storage object. */
  copy(input: { material: MaterialRef; targetParentId: string; actorId: string }): Promise<FinalizedMaterial>;

  /** Остаточне видалення: R2 — tombstone, не DELETE. */
  purge(input: { material: MaterialRef; reason: TombstoneReason }): Promise<void>;
}
```

`rename`, `move`, `trash`, `restore`, теги й папки для R2 — тільки SQL (RPC), адаптер їх не має. Для Drive вони лишаються в наявному коді `drive-ops` до етапу F.

## Інваріанти

1. `readUrl` викликається тільки після серверної перевірки права (`can_read_material`); адаптер права не перевіряє і не повинен викликатися з них в обхід.
2. `R2Adapter` ніколи не формує ключ з даних клієнта: ключ = `team_storage_objects.object_key`.
3. Жоден метод `R2Adapter` не викликає `DeleteObject` бібліотеки. Видаляє тільки робітник tombstones.
4. Помилки мапляться на коди data-model; тіла відповідей R2 не логуються (як у `fix(drive)…` для Drive).
