# Contract: маршрути сховища (edge-функція `storage-ops`)

Нова функція `supabase/functions/storage-ops`. Відповіді й помилки за конституцією V (той самий конверт, що в `drive-ops`). Усі маршрути користувача перевіряють JWT і членство; маршрут робітника приймає тільки named secret.

## Браузер і агент

| Метод і шлях | Тіло | Відповідь | Помилки |
| --- | --- | --- | --- |
| `POST /uploads/start` | `{teamId, fileName, contentType, declaredBytes, source, purpose}` | `{sessionId, partBytes, partsTotal, expiresAt}` | `STORAGE_DISABLED`, `STORAGE_QUOTA_EXCEEDED`, `STORAGE_OBJECT_TOO_LARGE`, `NOT_A_MEMBER` |
| `POST /uploads/:id/parts` | `{partNumbers: number[]}` (до 32) | `{parts: [{partNumber, url, expiresAt}]}` | `STORAGE_UPLOAD_EXPIRED` |
| `POST /uploads/:id/finalize` | `{parts: [{partNumber, etag, sha256}], sha256}` | `{material}` | `STORAGE_UPLOAD_MISMATCH`, `STORAGE_CONTENT_REJECTED`, `NOT_A_MEMBER` |
| `POST /uploads/:id/abort` | `{}` | `{}` | |
| `POST /derived/start` | `{materialId, role, contentType, declaredBytes}` | як `/uploads/start`; одна частина, якщо `declaredBytes ≤ partBytes` | |
| `POST /read-urls` | `{teamId, items: [{materialId, purpose, role?}]}` (до 200) | `{items: [{materialId, url, expiresAt}]}` | на елемент: `NOT_FOUND`, `PERMISSION_DENIED` |
| `POST /share-links` | `{materialId}` | `{url: "https://<site>/s/<token>", expiresAt}` | |
| `DELETE /share-links/:tokenHash` | | `{}` | |
| `GET /s/:token` | | `302 Location: <presigned GET>` | `404`, `410 SHARE_LINK_EXPIRED` |
| `GET /usage?teamId=` | | `{readyBytes, reservedBytes, quotaBytes, objectCount, largest: [...]}` | |

`purpose` (у `uploads/start`):

```ts
type UploadPurpose =
  | { kind: 'library'; parentId: string }                 // drive_file_id папки або root
  | { kind: 'task_attachment'; taskId: string }
  | { kind: 'overwrite'; materialId: string; expectedVersion: string }
  | { kind: 'process_output'; operationId: string };      // вихід агента, замінює /process/output/*
```

## Адміністратор Soty

| Метод і шлях | Тіло | Відповідь |
| --- | --- | --- |
| `POST /admin/cutover/schedule` | `{teamId, scheduledFor}` | `{run}` |
| `POST /admin/cutover/run` | `{teamId}` | `{run}` (ідемпотентно) |
| `POST /admin/tombstones/restore` | `{objectKey}` | `{material}` |
| `POST /admin/tombstones/release-pause` | `{teamId}` | `{released}` |
| `PATCH /admin/quota` | `{teamId, quotaBytesOverride \| null}` | `{quotaBytes}` |

## Робітник (`pg_cron`, named secret `STORAGE_WORKER_SECRET`)

`POST /worker/tick`: (1) прострочені upload-сесії → `AbortMultipartUpload`, резерв знято; (2) tombstones з `not_before <= now()` і без паузи → `DeleteObject` по одному ключу з перевіркою власності за `team_storage_objects` і відсутності uses (FR-019a), для `media` — очищення CDN; (3) запобіжник масового видалення; (4) кошик старший за `trash_days` → tombstones; (5) запланові переходи, яким настав час; (6) нічна звірка `team_storage_usage`.
