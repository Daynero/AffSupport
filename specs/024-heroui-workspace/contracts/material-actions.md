# Contract: what can be done to a material

**Feature**: 024-heroui-workspace | **File**: `apps/web/src/team/materials/actions.ts`

One registry. Every surface that shows a material renders from it: the explorer's rows and tiles,
the material detail surface, search results, a task's attachments, the catalog updater's list,
the selection bar, and the command palette.

The order below **is** the order on screen. Groups never reorder; items never reorder within a
group. A group with nothing resolved is omitted; a group with one item still shows its heading.

Legend for **Applies**: the object must be able to take this action at all. A false answer means
the item is **absent**, not disabled. Legend for **Needs**: the conditions that, when unmet,
leave the item present with one line of explanation (`Availability`, see `data-model.md` §5).

---

## Group 1 — Open

| id | Label key | Applies | Needs | Does |
|---|---|---|---|---|
| `open` | `materialActionOpen` | any material | `NOT_READY` while pending | folder: navigate into it. landing: the full view. video/image: the viewer. transcript/text: the text viewer. |
| `detail` | `materialActionDetails` | any material, host ≠ `explorer-detail` | — | opens the one detail surface |
| `showInFolder` | `materialActionShowInFolder` | not a folder; host ≠ `explorer-row`/`explorer-tile` | — | explorer opens that folder with the row selected; the host surface stays open behind it |

`showInFolder` from a task no longer closes the task (FR-019). It is the action the owner already
has; what changes is that it stops being the only one.

## Group 2 — Get

| id | Label key | Applies | Needs | Does |
|---|---|---|---|---|
| `copyLink` | `materialActionCopyLink` | any material | — | shares if needed, copies, confirms once |
| `share` | `materialActionShare` | any material | — | the remembered-choice share |
| `download` | `materialActionDownload` | not a folder | `NO_PERMISSION` (download) · `AGENT_REQUIRED` when the grant says so | browser download, or the agent path |
| `downloadRestitched` | `materialActionDownloadRestitched` | `category === 'video'` | `NO_PERMISSION` · `AGENT_REQUIRED` · `RESTITCH_UNCONFIGURED` | delivers the re-stitched copy; readiness is a word, not a dot |
| `copyText` | `materialActionCopyText` | transcript companion exists | `NOT_READY` unless ingest is `full` | copies the transcript |

`download` and `downloadRestitched` are two items with two names in one group, in one order,
once. Today they appear in four places under three names.

## Group 3 — Make

| id | Label key | Applies | Needs | Does |
|---|---|---|---|---|
| `productCatalog` | `materialActionProductCatalog` | `category === 'video'` | `NO_PERMISSION` (upload) · `STORAGE_DISCONNECTED` · `CATALOG_SETTINGS_MISSING` | opens the catalog dialog over the host surface. When a catalog exists the item reads "Open catalog" and the companion row carries open / copy link / remake |
| `transcribe` | `materialActionTranscribe` | `category === 'video'` | `NO_PERMISSION` (process) · `AGENT_REQUIRED` | the process flow with the transcription tool preselected |
| `compress` | `materialActionCompress` | `category === 'video'` | `NO_PERMISSION` (process) · `AGENT_REQUIRED` | enqueues on the space-level compression provider, so it works with no explorer mounted |
| `process` | `materialActionProcess` | category `video` or `landing` | `NO_PERMISSION` (process) · `AGENT_REQUIRED` | the process flow with the tool chosen inside |
| `processInside` | `materialActionProcessInside` | `kind === 'folder'` | `NO_PERMISSION` (process) · `AGENT_REQUIRED` | the scope dialog, which now also offers this folder / the selection / the whole space in one place |
| `regeneratePreview` | `materialActionRegeneratePreview` | `category === 'landing'` | `NO_PERMISSION` (edit) | re-renders the landing preview |
| `editText` | `materialActionEditText` | text or transcript | `NO_PERMISSION` (edit) · `NOT_READY` unless ingest is `full` | the text editor — wired up in the folder view, where it is currently dead |
| `createTask` | `materialActionCreateTask` | any material; host ≠ `task-attachment` | `NO_PERMISSION` (tasks) | a task pointing at it |

"Process" existed in five variants behind three dialogs. Here it is three items with clearly
different objects — this file, this folder, the selection — and one dialog that asks for the rest.

## Group 4 — Organise

| id | Label key | Applies | Needs | Does |
|---|---|---|---|---|
| `rename` | `materialActionRename` | not a folder | `NO_PERMISSION` (edit) | inline rename; the transcript companion follows |
| `move` | `materialActionMove` | not a folder | `NO_PERMISSION` (edit) | the folder picker as its own surface, not nested inside a popover |
| `colourTag` | `materialActionColourTag` | not a folder | `NO_PERMISSION` (owner) | the seven-colour picker — now offered in search results and on task attachments too |
| `uploadInto` | `materialActionUploadInto` | `kind === 'folder'` | `NO_PERMISSION` (upload) | file picker into that folder |
| `copy` / `cut` / `paste` | `materialActionCopy` … | host `explorer-*` | `NO_PERMISSION` (edit) for cut/paste | the clipboard operations that today exist only as keystrokes |

## Group 5 — Remove

Separated by a rule, always last, never the initial focus of a menu.

| id | Label key | Applies | Needs | Does |
|---|---|---|---|---|
| `detach` | `materialActionDetach` | host `task-attachment` | `NO_PERMISSION` (tasks) | removes it from the task — never from the Drive — with Undo. Worded so it cannot be mistaken for `trash` |
| `trash` | `materialActionTrash` | not a folder, not already trashed | `NO_PERMISSION` (delete) | trashes with the companion, offers Undo, asks nothing |
| `restore` | `materialActionRestore` | `trashed` | `NO_PERMISSION` (delete) | restores |

---

## Rules the registry enforces

1. **Absent or explained, never dead.** `applies === false` removes the item. A failed
   `available` keeps it with one line. Nothing is rendered grey and silent.
2. **At most four inline actions per surface.** The rest are behind one overflow. Inline choice
   is by `inlinePriority`, and only `ok` actions may go inline.
3. **Destructive last, separated, never focused first.**
4. **One outcome per action**, through the one toast channel, from the one error mapper.
5. **Reversible destructive actions offer Undo; irreversible ones confirm with a verb.**
6. **Running an action never closes its host.** The host passes itself as `host`; dialogs mount
   beside the host, not instead of it.
7. **Icons come from lucide at 20 px / stroke 1.75**, per the product's design rules; words live
   in the item, not only in a tooltip.
8. **A selection acts as one material of many.** With `host === 'selection'`, `applies` is the
   intersection over the selection and the labels say how many.

## What the test asserts

`tests/material-action-surfaces.test.tsx` resolves the registry for the same `MaterialRef`
against every `ActionHost` and asserts that, for actions that apply in more than one host, the
label key, the icon, the group and the position are identical (SC-003).

`tests/material-action-registry.test.ts` asserts: every action has a translation key that exists;
no group renders more than seven items without a heading (SC-004); every `destructive` action is
in `remove`; no host resolves more than four inline actions; the union of ids is closed.
