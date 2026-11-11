# Data Model: 051

## Стан каналу (`state.json`, машина релізу)

```jsonc
{
  "schemaVersion": 1,
  "next": {                      // null, коли кандидата немає
    "status": "testing" | "cancelled" | "promoted",
    "build": BuildRecord,        // остання збірка на next
    "builds": number,            // скільки збірок цього кандидата вже було
    "startedAt": iso
  } | null,
  "production": BuildRecord | null,   // що зараз на проді
  "previous": BuildRecord[]           // попередні розкочені, найновіша перша (≥2 зберігаються)
}
```

**BuildRecord**:

- `outputDigest`: sha256 бандла, 64 hex; ключ архіву;
- `sourceSha`, `manifestSha`: 40 hex;
- `manifestDigest`: sha256 `stable.json` у бандлі;
- `indexDigest`: sha256 `index.html`;
- `version`, `buildId`: з маніфесту бандла;
- `deployedAt`: iso;
- `channel`: `next` | `production`;
- `kind`: `full` | `web-only` | `adopted`.

**Правила**:

- `next.build.outputDigest` мусить існувати в `bundles/`, і його `outputDigest()` збігається;
- promote дозволено лише при `next.status === 'testing'`;
- rollback бере `previous[0]`, а при повторному виклику — наступний;
- кожна зміна — один атомарний запис (temp + rename) під lock і рядок у `history.jsonl`.

**Переходи**: publish(next) → testing (кожна нова збірка замінює `build`, `builds++`) →
promote → `production = build`, старий `production` іде в `previous`, `next.status = promoted`;
або cancel → `next.status = cancelled`, а `next` знову віддає production-бандл.
Rollback: `production` іде в голову `rolledBack`-історії, `production = previous.shift()`.

## `history.jsonl`

Один рядок на операцію: `{ op: publish|promote|rollback|cancel|adopt, at, from?, to, result: ok|failed|uncertain, code?, detail? }`.

## БД: `public.release_testers`

| колонка  | тип                                       |     |
| -------- | ----------------------------------------- | --- |
| user_id  | uuid PK → auth.users on delete cascade    |     |
| added_by | uuid null → auth.users on delete set null |     |
| added_at | timestamptz not null default now()        |     |

- RLS увімкнено. Без політик для anon і authenticated: доступ лише через security definer функції.
- `is_release_tester() → boolean`: `is_admin()` або є рядок для `auth.uid()`.
- `admin_list_release_testers() → table(user_id, email, added_at)`, лише для адміна.
- `admin_add_release_tester(p_email text) → uuid`, лише для адміна; невідомий email дає помилку `RELEASE_TESTER_UNKNOWN_EMAIL`.
- `admin_remove_release_tester(p_user_id uuid) → boolean`, лише для адміна.
