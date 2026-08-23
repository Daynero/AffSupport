# Contracts — Team Mode UX Refresh (010)

Interfaces this feature adds or changes. Everything not listed here is reused unchanged from
001/002/004/005.

| File | Contract |
|---|---|
| [routes-and-navigation.md](./routes-and-navigation.md) | The `/team/…` address scheme, resolver order, and navigation semantics (Back/refresh/links) |
| [rpc-and-backend.md](./rpc-and-backend.md) | Three new SQL functions + one listing read: signatures, permissions, errors, audit rows |
| [glossary.md](./glossary.md) | The enforced user-facing vocabulary (uk/en), forbidden terms, Close vs Cancel — backed by a repo test |
| [ui-conventions.md](./ui-conventions.md) | Dialog behavior contract, toast/notification contract, sync/status rendering, background-work chip |

Stability rules:

- Error values remain stable machine codes (constitution V); new codes introduced here:
  `TEAM_NOT_DRAFT`. Reused codes: `OWNER_TRANSFER_REQUIRED`, `EXTERNAL_DRIVE_ACCESS_REMAINS`,
  existing file-operation codes.
- No agent HTTP contract, shared-package constant, or release/manifest fact changes.
- `drive-ops` Edge Function is consumed as-is (`trash`, `restore` already exist).
