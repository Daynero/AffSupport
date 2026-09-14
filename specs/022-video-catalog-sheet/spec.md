# Feature Specification: Video Catalog Sheet

**Feature Branch**: `022-video-catalog-sheet`

**Created**: 2026-09-15

**Status**: Draft

**Input**: Owner's description, 2026-09-15, condensed from two messages:

> On a video there is "Create catalog". It opens a dialog asking for a link and for how many
> products to create — a three-digit field, 100 by default, a whole number that is not zero and not
> more than 400. After OK, a spreadsheet is created from the template (example file `11.xlsx`). The
> first column is the id — for now just the row number from 1 to the product count. Title,
> description, price and the image link come from a separate catalog settings page in the space
> settings; whatever is set there is repeated on every product. The price is entered there as a
> whole number and written into the sheet with `,00 USD` added. The link column is the link pasted
> into the dialog. `sale_price` is a copy of `price`. Column Z, `video[0].url`, is the link-shared
> Google link of the video the catalog is made from, with `?v=001` added on the first product,
> `?v=002` on the second and so on, so every product's video link is different. Every other column
> is as in the example. The sheet is put next to the video and tied to it the way the transcript
> is, so it is quicker to find, and at the end I get the shared Google link to the sheet. This
> should ship as a web update, without a full release.

## Why This Exists

Preparing a product catalog for a video is manual today: turn on link sharing for the video, copy
its link, open the catalog template, fill title, description, price, image, the offer link and a
distinct video link on each of up to hundreds of rows, share the sheet, and remember where it was
saved. The values are the same for the whole space and the rows differ only by number, so almost
all of that work is mechanical — and the result is not connected to the video, so the next person
has to search for it.

This feature turns it into one action on the video: paste the offer link, choose how many products,
confirm, and get a shareable link to a filled catalog that lives next to the video and travels with
it, exactly like its transcript does.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Create a catalog from a video (Priority: P1)

A teammate looks at a video in the team space and chooses "Create catalog". The dialog asks for a
link and for a product count, prefilled with 100. They paste the link, keep or change the count,
and confirm. A few seconds later the dialog shows the link to a new sheet with a one-click copy.
The sheet follows the catalog template: one row per product, numbered from 1, each carrying the
space's catalog title, description, price and image link, the pasted link, and its own numbered
variant of the video's shareable link. Anyone with the sheet link can open it.

**Why this priority**: This is the whole value of the feature. With only this, the manual routine
is gone.

**Independent Test**: With catalog settings filled for the space, create a catalog of 3 products
on a video, open the returned link in a signed-out browser, and check every column of the three
rows against the [catalog template](contracts/catalog-template.md), including that Z holds
`…?v=001`, `…?v=002`, `…?v=003` and that the link opens the video.

**Acceptance Scenarios**:

1. **Given** a video with no catalog, filled space catalog settings, and a person allowed to add
   files to the video's folder, **When** they choose "Create catalog", paste a web link, keep the
   count at 100 and confirm, **Then** a sheet with the template's two header rows and 100 product
   rows is created next to the video, and the dialog shows its shareable link with copy and open
   actions.
2. **Given** the dialog, **When** the count is empty, zero, negative, fractional, not a number, or
   greater than 400, **Then** confirmation is refused with an inline explanation of the allowed
   range (1–400) and nothing is created.
3. **Given** the dialog, **When** the link is not a web link, **Then** confirmation is refused with
   an inline explanation and nothing is created.
4. **Given** a catalog of N products, **When** its rows are read, **Then** column A holds 1…N,
   column Z holds the video link followed by `?v=001` … the N-th number padded to three digits,
   column F holds the space's price as `<price>,00 USD`, column M equals column F on every row, and
   every other column matches the template.
5. **Given** the video was not yet shared by link, **When** the catalog is created, **Then** the video
   becomes viewable by anyone with its link, with no extra confirmation step.
6. **Given** the returned sheet link, **When** someone without access to the team space opens it,
   **Then** they can view the sheet, and the video link in column Z opens the video.

---

### User Story 2 - Set the space's catalog settings (Priority: P1)

Someone who manages the space opens the catalog page in the space settings and fills in the
title, description, price and image link that every catalog in this space uses. Everyone creating
a catalog in the space then gets those values without typing them.

**Why this priority**: Four of the template's required columns come only from here. Without it no
correct catalog can be created, so it ships together with US1.

**Independent Test**: As a space manager, fill the four settings and save; reload and see them
kept; as a member without that permission, see them read-only; create a catalog and find the values
in columns B, C, F, H and M.

**Acceptance Scenarios**:

1. **Given** a person who manages the space, **When** they open space settings, **Then** there is a
   separate catalog page with Title, Description, Price and Image link.
2. **Given** they enter values and save, **When** anyone in the space reopens the page, **Then** the
   saved values are shown.
3. **Given** a member who does not manage the space, **When** they open the catalog page, **Then**
   they see the values but cannot change them.
4. **Given** the Image link field, **When** the value is not a web link, **Then** saving is refused
   with an inline explanation and the previous value is kept.
5. **Given** the Price field, **When** the value is not a whole number (for example `10.5`, `10,00`,
   `USD 10`, `-3` or `0`), **Then** saving is refused with an inline explanation; `10` is accepted and
   catalogs show it as `10,00 USD`.
6. **Given** any of the four settings is empty, **When** someone opens "Create catalog", **Then** the
   dialog says which settings are missing, links to the catalog settings page, and does not allow
   confirmation.
7. **Given** the settings change, **When** a new catalog is created, **Then** it uses the new values,
   and catalogs created earlier are not modified.

---

### User Story 3 - Find the catalog from the video (Priority: P1)

Anyone in the space who looks at a video that already has a catalog sees that it exists and can
open it or copy its link straight from the video, without searching the folder.

**Why this priority**: The owner's stated reason for tying the sheet to the video is to find it
faster. A catalog that must be searched for is only half the feature.

**Independent Test**: Create a catalog as one teammate, then, as a second teammate, open the same
video and open and copy the catalog link from the video's card and its row actions.

**Acceptance Scenarios**:

1. **Given** a video that has a catalog, **When** any teammate who can see the video opens its card
   or row actions, **Then** they see "Open catalog" and "Copy catalog link" in place of "Create
   catalog".
2. **Given** a catalog was just created by a teammate, **When** another teammate is looking at the
   same video, **Then** the catalog appears for them without a manual refresh.
3. **Given** the folder view, **When** a person looks at the sheet itself, **Then** it is shown as
   belonging to its video, the same way a transcript is.

---

### User Story 4 - The catalog follows its video (Priority: P2)

When a video is renamed, moved, copied or deleted through the team space, its catalog is handled
the way its transcript already is, so a catalog never ends up orphaned or misnamed.

**Why this priority**: Without it, the link between sheet and video decays after the first rename
or move, and the "quick to find" promise quietly breaks. It follows creating and finding.

**Independent Test**: Create a catalog, then rename, move, copy and delete the video in turn, and
check the catalog's name, location and link after each step.

**Acceptance Scenarios**:

1. **Given** a video with a catalog, **When** the video is renamed, **Then** the catalog is renamed to
   match the new video name.
2. **Given** a video with a catalog, **When** the video is moved to another folder, **Then** the
   catalog moves into the same folder and stays linked.
3. **Given** a video with a catalog, **When** the video is copied, **Then** the copy has no catalog and
   offers "Create catalog" (a catalog's column Z points at one specific video).
4. **Given** a video with a catalog, **When** the video is deleted, **Then** its catalog goes to the
   trash with it, without a question — the way its transcript already does.
5. **Given** a catalog, **When** it is deleted directly, **Then** only the sheet is deleted and the
   video offers "Create catalog" again.

---

### User Story 5 - Re-create a catalog (Priority: P3)

A person who pasted the wrong link, chose the wrong count, or whose space settings changed,
re-creates the catalog for a video from the video's actions.

**Why this priority**: Useful and expected, but a person can already delete the sheet and create a
new one, so it is a convenience on top of the stories above.

**Independent Test**: Create a catalog of 100, choose "Re-create catalog", change the link and set
the count to 5, confirm; check that the video has exactly one catalog, with 5 rows and the new link,
and the previous one is in the trash.

**Acceptance Scenarios**:

1. **Given** a video with a catalog, **When** a person chooses "Re-create catalog", **Then** the dialog
   opens prefilled with the previous link and product count and warns that the current catalog
   will be replaced and its link will stop pointing at the current version.
2. **Given** they confirm, **When** the new catalog is ready, **Then** it becomes the video's only
   catalog and the previous one is moved to trash.

---

### Edge Cases

- **Drive not connected or disconnected** for the space: the action is shown disabled with the same
  explanation other Drive actions give; nothing is created.
- **Space catalog settings incomplete**: the dialog names the missing settings and links to the
  catalog settings page (US2, scenario 6); a person who cannot manage the space is told who can.
- **The person may not share the video** (Drive refuses sharing for them or the space): creation
  stops before the sheet is made, and the dialog says why; no half-made sheet is left behind.
- **Sheet created but filling, sharing or linking fails**: the attempt is rolled back (the sheet is
  moved to trash), so a failed creation never leaves an unlinked, unshared or partly filled sheet.
- **Double confirm or a retried request**: exactly one catalog results.
- **Two teammates create a catalog for the same video at the same time**: exactly one catalog
  remains linked; the other person is shown the existing catalog instead of an error.
- **A file with the catalog's name already exists** in the folder: the catalog is still created,
  named so it does not collide, and still linked to its video.
- **The video is deleted or moved to trash while the dialog is open**: confirmation fails with a
  clear message and nothing is created.
- **The sheet is deleted or moved directly in Drive**, outside the team space: after the next
  catalog refresh the video no longer shows a catalog it cannot open, and offers "Create catalog".
- **A value begins with `=`, `+`, `-` or `@`** (a pasted link, a description): it is stored as plain
  text, exactly as entered, and never evaluated as a formula.
- **Count with leading zeros or surrounding spaces** (`007`): accepted as the number it denotes; the field
  never holds more than three digits.
- **The desktop app is not running, not installed, or on an older version**: the feature works
  anyway; nothing in it depends on the local agent.

## Requirements _(mandatory)_

### Functional Requirements

**Creating**

- **FR-001**: A video in a Drive-connected team space MUST offer "Create catalog" to anyone
  permitted to add files to the video's folder, and MUST NOT offer it on materials that are not
  videos.
- **FR-002**: "Create catalog" MUST open a dialog with two required fields: a link, accepting only
  web links (`http`/`https`), and a product count, holding at most three digits, prefilled with
  `100`, accepting only whole numbers from 1 to 400. Any refusal MUST be explained inline, and
  confirm MUST stay unavailable until both fields are valid.
- **FR-003**: The dialog MUST NOT allow confirmation while any of the space's catalog settings
  (Title, Description, Price, Image link) is empty; it MUST name the missing ones and link to the
  catalog settings page.
- **FR-004**: Creating a catalog MUST make the video viewable by anyone with its link when it is
  not already, without a separate confirmation step or warning in the dialog.
- **FR-005**: On confirm, the system MUST create a spreadsheet exactly as defined by the
  [catalog template contract](contracts/catalog-template.md): one sheet named `catalog_products`;
  row 1 the template's field descriptions; row 2 the field keys; then one row per product, as many
  as the chosen count.
- **FR-006**: Each product row MUST be filled per the contract: column A the row's number (1 to
  count); B, C, H the space's Title, Description, Image link; F the space's Price followed by
  `,00 USD` (a price of `10` is written `10,00 USD`); G the link from the dialog; M a copy of F; Z the video's link-shared Google Drive link followed by `?v=` and the row number
  padded to three digits; every other column the fixed value the contract gives.
- **FR-007**: Every product row's column Z MUST be distinct from every other row's in the same
  catalog.
- **FR-008**: Text values MUST be stored as literal text and never evaluated as formulas; columns A
  and L MUST be stored as numbers; column AB MUST be stored as text so it is shown in full.
- **FR-009**: The spreadsheet MUST be created in the same folder as the video, named after the video
  (the video's name without its extension, followed by ` catalog` — `clip.mp4` gets `clip catalog`),
  and MUST open as a native Google spreadsheet, not as a downloadable file.
- **FR-010**: The spreadsheet MUST be viewable by anyone with its link, and the dialog MUST end by
  showing that link with copy and open actions.
- **FR-011**: A creation that cannot complete every step (create, fill, share, link) MUST leave no
  catalog behind: anything partially created is moved to trash, and the person sees one message
  saying what failed and whether retrying can help.
- **FR-012**: Repeating the same confirmation (double click, network retry) MUST result in exactly
  one catalog.

**Space catalog settings**

- **FR-013**: Space settings MUST include a separate catalog page with four fields: Title,
  Description, Price and Image link.
- **FR-014**: Only people who manage the space (the permission that governs other space-wide
  settings) MAY change the catalog settings; every member of the space MAY view them.
- **FR-015**: Image link MUST accept only web links. Title and Description MUST respect the
  template's character limits (200 and 9999). Price MUST accept only a whole number from 1 to
  999999, entered without currency or decimals; the field shows how it will appear in the sheet
  (`10` → `10,00 USD`).
- **FR-016**: A catalog MUST capture the settings as they were at creation; later changes MUST NOT
  modify existing catalogs.

**Linking and finding**

- **FR-017**: A catalog MUST be linked to its video as a companion — at most one catalog per video,
  independent of the video's transcript — with the same visibility as a transcript companion.
- **FR-018**: A video's card and row actions MUST show "Open catalog" and "Copy catalog link" when a
  catalog exists, and "Create catalog" when it does not; these MUST fit the existing compact actions
  presentation rather than add a row of buttons.
- **FR-019**: A newly created, re-created or removed catalog MUST appear for every teammate viewing
  the video without a manual refresh.
- **FR-020**: The sheet MUST be recognisable in the folder as belonging to its video.

**Following the video**

- **FR-021**: Renaming a video MUST rename its catalog to match.
- **FR-022**: Moving a video MUST move its catalog into the same destination and keep the link.
- **FR-023**: Copying a video MUST NOT copy its catalog; the copy starts without one.
- **FR-024**: Deleting a video that has a catalog MUST move the catalog to the trash too, without a
  question, as the transcript is; deleting a catalog directly MUST only delete the sheet and unlink
  it.
- **FR-025**: A catalog removed outside the team space MUST stop being shown as the video's catalog
  after the next catalog refresh.

**Re-creating**

- **FR-026**: A video with a catalog MUST offer "Re-create catalog", which opens the dialog prefilled
  with the previous link and product count and warns that the current catalog will be replaced.
- **FR-027**: Confirming a re-creation MUST leave exactly one catalog linked to the video (the new
  one) and move the previous one to trash.

**Delivery**

- **FR-028**: The feature MUST work for people on the currently released desktop app version and
  when the desktop app is not running, and MUST be deliverable without publishing a new desktop app
  version.
- **FR-029**: The feature MUST NOT require people or spaces to grant Google Drive any access beyond
  what a connected space has already granted.

### Key Entities

- **Catalog**: a spreadsheet of products made from one video. Belongs to exactly one video as its
  catalog companion; lives in the video's folder; has a shareable link; records the pasted link and
  the product count it was created with, so a re-creation can offer them again.
- **Catalog template**: the fixed definition of the sheet — sheet name, the two header rows, and for
  each of the 31 columns where its value comes from (row number, space setting, dialog link, copy of
  another column, numbered video link, or a fixed value). Defined in
  [`contracts/catalog-template.md`](contracts/catalog-template.md) and
  [`contracts/catalog-template.json`](contracts/catalog-template.json).
- **Space catalog settings**: one set per space — Title, Description, Price, Image link — changed by
  the space's managers, used by every catalog created in the space.
- **Video** (existing): the material a catalog is made from; may have at most one catalog alongside
  at most one transcript.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: With the space's settings filled, a person goes from choosing "Create catalog" to
  holding a copied, working sheet link in under 30 seconds; the wait after confirm is under 15
  seconds in 95% of attempts, for any count up to 400.
- **SC-002**: In 100% of created catalogs, every product row matches the template contract
  cell-for-cell, the row count equals the chosen count, and no two rows share a column Z value.
- **SC-003**: 100% of catalogs open from their returned link for a signed-out viewer, and the video
  link in column Z opens the video.
- **SC-004**: Finding an existing catalog from its video takes one action from the video's card or
  row actions, for every teammate who can see the video.
- **SC-005**: After any rename, move or delete of a video through the team space, zero catalogs are
  left misnamed, in the wrong folder, or linked to nothing.
- **SC-006**: A failed creation leaves zero partial sheets in the folder.
- **SC-007**: The feature reaches all users with the web update, with zero people needing to
  install or update the desktop app, and no space needing to reconnect Google Drive.

## Assumptions

- **Google spreadsheet, not an `.xlsx` file.** The owner's example is an `.xlsx` exported from Google
  Sheets and the returned link is a Google link opened in the browser, so the catalog is a native
  Google spreadsheet; an `.xlsx` can be downloaded from it at any time.
- **The template lives in the product.** Its fixed values are the owner's example values; changing
  them is a product change, not a setting. A person-kept template file in Drive would not be
  readable under the Drive access the product holds.
- **`id` needs to be unique within one catalog only.** Every catalog numbers its products from 1;
  catalogs are never combined, so the numbers never meet (owner, 2026-09-15).
- **Price is in USD with a comma and zero cents** (`10,00 USD`), as in the owner's example; the
  currency is not a setting.
- **No sharing warnings.** The pasted link and the resulting sheet link belong to the person who
  made the catalog and are not passed on; making the video and the sheet viewable by link is simply
  what creating a catalog does.
- **Column Z follows the example literally**: `?v=NNN` is appended to the shared link as is, even
  though that link already contains `?`.
- **Who may create**: anyone permitted to add files to the video's folder; anyone who can see the
  video can open and copy its catalog link. **Who may change settings**: whoever manages the space,
  as for the space's other defaults.
- **A copied video gets no catalog** because a catalog's column Z points at one specific file.
- **Deleting follows the transcript's current behaviour**: feature 012 first asked "delete the
  transcript too?", and the owner later dropped the question — a video's companions go to the trash
  with it, recoverable from there. The catalog does the same (corrected during planning,
  2026-09-15).
- **Out of scope**: bulk catalog creation for many videos at once; editing a catalog's rows from
  inside the team space; per-person or per-video overrides of the space settings; editing the
  template's fixed values from the UI; catalogs for non-video materials.
- **Delivery constraint** (owner, 2026-09-15): ships as a backend change plus a web update, with no
  desktop app release. Code-level analysis supporting this is in [`findings.md`](findings.md).
