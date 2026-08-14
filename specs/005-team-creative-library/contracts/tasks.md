# Contract: Team Task Space & Media Attachments

## Authorization

- Read/list/get requires active membership + `view`.
- Create, edit, status/progress, attach, detach and reorder require `edit`.
- Assignee must be an active member in the same team at write time.
- Every attached material is independently exact-team and visible. A forged drag/search id
  cannot reveal or attach a foreign/hidden material.

## Create/get/list tasks

`create_team_task(p_team,p_title,p_note,p_assignee,p_initial_material default null)` creates
one `todo` task with max=100, value=0, manual=false. If an initial material is present, the
same transaction validates and attaches it. The response is the complete closed task summary,
and the UI opens its editor immediately.

`list_team_tasks(p_team,p_created_from default null,p_created_to default null,p_cursor
default null,p_page_size default 50)` returns task cards ordered by `created_at desc,id`.
Bounds are UTC instants computed from the user's local selected calendar day. Both or neither
must be supplied, `from < to`, and the range is half-open. All Time supplies neither.

`get_team_task(p_team,p_task,p_attachment_cursor,p_attachment_page_size)` returns the task and
paged attachments. A task can have any total number of attachments; paging is not a semantic
maximum.

## Update status and progress

`update_team_task(p_team,p_task,p_patch)` accepts only title, note, assignee, status,
progressMax and progressValue.

- explicit progressValue permanently sets `progressManuallySet=true`, even if unchanged;
- max is integer 1–10,000 and value integer 0–max;
- lowering max below current value requires a valid explicit value in the same patch;
- changing status to done sets value=max only while manual=false;
- later status changes never rewrite a manually controlled value;
- leaving done does not reduce progress automatically.

Concurrent updates use `updatedAt`/revision precondition and return `SOURCE_CHANGED` instead
of silently losing edits.

## Attach/detach/reorder

`attach_team_task_materials(p_team,p_task,p_materials[])` accepts a bounded mutation batch
(100 ids) that can be called repeatedly. It returns:

`{ attached:[id...], alreadyAttached:[id...], rejected:[{ materialId,code }] }`.

Valid attachments commit even if other ids are rejected. Unique `(task,material)` makes
duplicates idempotent. The operation creates only join rows: no Drive/catalog metadata,
location, parent, bytes or provenance changes.

Search selection and drag-and-drop both call this function. The typed drag payload contains
only same-session material ids; it is never authority. Detach removes only the join row.

## Attachment projection and preview

Each attachment returns safe catalog identity/category/lifecycle plus preview state. It does
not return transcript text or provider ids. Tiles resolve previews through existing scoped
surfaces:

- image/static: authorized media image;
- landing: current cached feature-004 render, otherwise typed fallback;
- video: muted/preloaded media seeks to 1.0 s (or final instant if duration <1 s) and becomes
  ready only on `seeked`;
- other/unavailable: explicit category fallback.

Move/rename leaves the stable attachment intact. Trash/missing/permission loss keeps the task
but projects an unavailable tile. Video text actions use the separate video-variant contract.

## Task space UX contract

- Workspace exposes a dedicated Tasks view in one primary action.
- Editor has a permission-filtered search picker and a left navigable/draggable material
  tree; both support selecting many assets.
- Create Task is a visible keyboard/touch action on asset cards and attaches/opens in one
  operation. A context menu may mirror it but cannot be the only path.
- Attachments render as a compact responsive grid; drag always has a keyboard/search
  alternative.
- Date picker plus Today, Yesterday and All Time show the active filter and never mutate task
  data.
