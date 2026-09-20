# Data model — 024 the team workspace on HeroUI

No database entity changes. Everything here is a front-end shape: the vocabulary the workspace
uses to describe what a person is looking at and what they may do to it. Types live in
`apps/web/src/team/materials/actions.ts` unless stated otherwise.

---

## 1. `MaterialRef` — the little that identifies a material anywhere

Deliberately structural and narrower than any of the four row shapes that satisfy it
(`TeamMaterialSummary`, `CatalogMaterialItem`, `TeamTaskAttachmentSummary`, the updater's
registry row), so that no surface has to widen its query to offer an action. This is the same
discipline `RowMaterial` already follows and the reason file actions escaped the search results
once before.

| Field                   | Type                                                              | Notes                                             |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `id`                    | `string`                                                          | the material id                                   |
| `teamId`                | `string`                                                          |                                                   |
| `name`                  | `string`                                                          |                                                   |
| `kind`                  | `MaterialKind`                                                    | `folder` decides most `applies` answers           |
| `category`              | `string \| null`                                                  | `video`, `landing`, `image`, … — decides "make"   |
| `fileExtension`         | `string \| null`                                                  |                                                   |
| `sizeBytes`             | `number \| null`                                                  |                                                   |
| `parentFolderId`        | `string \| null`                                                  | null when the surface does not know it            |
| `trashed`               | `boolean`                                                         |                                                   |
| `availability`          | `'ready' \| 'pending' \| 'trashed' \| 'missing' \| 'unavailable'` | a task attachment's own word, `'ready'` elsewhere |
| `transcriptIngestState` | `TranscriptIngestState \| undefined`                              | gates "edit text"                                 |
| `driveVersion`          | `string \| null`                                                  | re-stitch delivery needs it                       |
| `companions`            | `MaterialCompanions`                                              | §3                                                |

## 2. `ActionContext` — where the offer is being made

| Field                  | Type              | Notes                                                                                                                                         |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                 | `ActionHost`      | `'explorer-row' \| 'explorer-tile' \| 'explorer-detail' \| 'search-result' \| 'task-attachment' \| 'updater-row' \| 'selection' \| 'palette'` |
| `permissions`          | `TeamPermissions` | the caller's, as the space already computes them                                                                                              |
| `isOwner`              | `boolean`         | colour tags are owner-only today                                                                                                              |
| `currentFolderId`      | `string \| null`  | the folder an upload or a paste would land in                                                                                                 |
| `agentConnected`       | `boolean`         | the local app is paired and new enough                                                                                                        |
| `storageConnected`     | `boolean`         | Drive is connected and healthy                                                                                                                |
| `restitchConfigured`   | `boolean`         | the space has re-stitch defaults                                                                                                              |
| `catalogSettingsReady` | `boolean`         | the space has product-catalog defaults                                                                                                        |
| `selectionSize`        | `number`          | 1 unless `host === 'selection'`                                                                                                               |

`host` exists so an action can decline where it is meaningless (`detach` outside a task,
`show in folder` inside the folder it lives in) — **not** so a host can have a different list.
Where an action applies, its label, its icon, its group and its order are the same everywhere.
That equality is what `tests/material-action-surfaces.test.tsx` asserts.

## 3. `MaterialCompanions` — what lives beside a material

Companions are shown on the material itself wherever it appears (FR-020), never buried.

| Field            | Type                                                  | Notes                            |
| ---------------- | ----------------------------------------------------- | -------------------------------- |
| `productCatalog` | `{ id, name, link, productCount, updatedAt } \| null` | feature 022                      |
| `transcript`     | `{ id, state, variant } \| null`                      | feature 012                      |
| `restitched`     | `{ preparedFor: string \| null } \| null`             | prepared against a drive version |

A companion that exists turns its "make" action into an "open / copy link / remake" trio on the
material's detail surface, and adds one line to the row.

## 4. `MaterialAction` — one entry of the registry

| Field            | Type                                                  | Notes                                                    |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `id`             | `MaterialActionId`                                    | a closed union; the analytics name and the test key      |
| `group`          | `'open' \| 'get' \| 'make' \| 'organise' \| 'remove'` | fixed order, in that order                               |
| `order`          | `number`                                              | within the group                                         |
| `labelKey`       | `TranslationKey`                                      | never a literal string                                   |
| `icon`           | `LucideIcon`                                          | 20 px, stroke 1.75, as the design rules require          |
| `destructive`    | `boolean`                                             | forces the group to `remove` and the separation rule     |
| `inlinePriority` | `number \| null`                                      | `null` = menu only. The three highest per host go inline |
| `applies`        | `(m: MaterialRef, c: ActionContext) => boolean`       | false ⇒ **absent**, never disabled                       |
| `available`      | `(m: MaterialRef, c: ActionContext) => Availability`  | §5                                                       |

## 5. `Availability` — the third state the product did not have

```ts
type Availability = { ok: true } | { ok: false; reason: UnavailableReason };
```

`UnavailableReason` is a closed union of machine codes, mapped to sentences by the one existing
mapper in `team/errors.ts`:

| Reason                     | Shown as (one line, under the item)     | Carries                   |
| -------------------------- | --------------------------------------- | ------------------------- |
| `NO_PERMISSION`            | your role cannot do this                | —                         |
| `AGENT_REQUIRED`           | the Soty app is not running             | the open/install action   |
| `AGENT_UPDATE_REQUIRED`    | the Soty app is too old                 | the update action         |
| `STORAGE_DISCONNECTED`     | the space's Drive is not connected      | settings link, owner only |
| `CATALOG_SETTINGS_MISSING` | the space has no catalog defaults yet   | settings link             |
| `RESTITCH_UNCONFIGURED`    | the space has no re-stitch settings yet | settings link             |
| `NOT_READY`                | the file is still being prepared        | —                         |
| `TRASHED`                  | the file is in the trash                | restore                   |
| `MISSING`                  | the file is no longer on the Drive      | detach / remove           |

The rule the product did not have before: **absent ≠ unavailable**. A folder can never be
catalogued, so the item is not there. A video whose Drive is disconnected can be catalogued
tomorrow, so the item is there with one line saying why not today.

## 6. `MaterialActionList` — what a surface actually renders

```ts
interface MaterialActionList {
  inline: ResolvedAction[]; // at most four, by inlinePriority, ok-only
  groups: ActionGroup[]; // open · get · make · organise · remove
  count: number;
}
interface ResolvedAction {
  action: MaterialAction;
  availability: Availability;
  run(): Promise<void>;
}
```

Produced by `useMaterialActionList(material, context)`. A group with no resolved action is
omitted; a group with one is still headed, because the heading is what makes the menu scannable.

## 7. `MaterialDetail` — the one detail surface

The shape a material is described by, identically from folder, search, task and updater:
preview (thumbnail, poster frame or kind glyph), name, kind, size, modified, folder, colour tag,
`MaterialCompanions`, and the full `MaterialActionList`. It is a component, not a fetch: every
host already has the row it needs, and the detail surface asks for only what is missing.

## 8. `ThemeBridge` — Soty tokens to library variables

Not a TypeScript type; a CSS contract, specified in
[`contracts/theme-bridge.md`](./contracts/theme-bridge.md). It has two halves:

- **HeroUI variables**, defined in `styles/tokens.css` from Soty roles, so the library is themed
  once and inherits the dark flip for free.
- **Tailwind theme**, declared with `@theme inline` in `styles/tailwind.css`, so utilities resolve
  a token at the point of use rather than at the point of declaration — which is what makes a
  utility correct inside a `[data-theme='dark']` subtree.

## 9. `PaletteEntry` — a thing reachable by name

| Field      | Type                                                                    | Notes                                                      |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `kind`     | `'space' \| 'folder' \| 'material' \| 'task' \| 'account' \| 'command'` |                                                            |
| `id`       | `string`                                                                |                                                            |
| `title`    | `string`                                                                | what is matched and shown                                  |
| `subtitle` | `string \| null`                                                        | folder path, account name, task status                     |
| `icon`     | `LucideIcon`                                                            |                                                            |
| `go`       | `() => void`                                                            | navigate to it                                             |
| `actions`  | `ResolvedAction[]`                                                      | for a material, the §6 list; for a task, its safe bulk set |

## 10. What is not modelled here

Task, attachment, account, agent, member, invitation and catalog shapes are unchanged and keep
living in `@video-compressor/shared`. This feature adds no field to any of them, which is what
keeps it web-only deployable.
